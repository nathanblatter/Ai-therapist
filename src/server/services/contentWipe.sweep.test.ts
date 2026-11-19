import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

const redactSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./sessionRedaction.service.js', () => ({
  redactSession: redactSessionMock,
}));

const { wipeAgedThreadMessageBodiesMock } = vi.hoisted(() => ({
  wipeAgedThreadMessageBodiesMock: vi.fn(),
}));
vi.mock('../db/messagingRetention.queries.js', () => ({
  wipeAgedThreadMessageBodies: wipeAgedThreadMessageBodiesMock,
}));

import {
  findEndedSessionsWithRedactionGaps,
  sweepRedactionGaps,
  executeContentWipe,
  getWipeStats,
  retentionCutoff,
} from './contentWipe.service.js';
import { _resetRecentTurnsForTests, recentTurns, rememberTurn } from '../utils/recentTurns.js';

beforeEach(() => {
  queryMock.mockReset();
  redactSessionMock.mockClear();
  wipeAgedThreadMessageBodiesMock.mockReset().mockResolvedValue(0);
});

describe('findEndedSessionsWithRedactionGaps', () => {
  it('queries for ended sessions with a not-yet-redacted user/assistant message', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ session_id: 'abc' }] });

    const ids = await findEndedSessionsWithRedactionGaps();

    expect(ids).toEqual(['abc']);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("ts.status = 'ended'");
    expect(sql).toContain('m.content IS NOT NULL');
    expect(sql).toContain('m.content_redacted IS NULL');
    expect(sql).toContain("role IN ('user', 'assistant')");
  });

  it('returns an empty array when nothing is pending', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const ids = await findEndedSessionsWithRedactionGaps();
    expect(ids).toEqual([]);
  });
});

describe('sweepRedactionGaps', () => {
  it('does nothing (and never calls redactSession) when there are no gaps', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await sweepRedactionGaps();

    expect(result).toEqual({ sweptSessions: 0 });
    expect(redactSessionMock).not.toHaveBeenCalled();
  });

  it('re-runs redactSession for every ended session with a gap', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ session_id: 'session-a' }, { session_id: 'session-b' }],
    });

    const result = await sweepRedactionGaps();

    expect(result).toEqual({ sweptSessions: 2 });
    expect(redactSessionMock).toHaveBeenCalledTimes(2);
    expect(redactSessionMock).toHaveBeenCalledWith('session-a');
    expect(redactSessionMock).toHaveBeenCalledWith('session-b');
  });

  it('keeps sweeping the remaining sessions even if one redactSession call rejects', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ session_id: 'fails' }, { session_id: 'ok' }],
    });
    redactSessionMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    const result = await sweepRedactionGaps();

    expect(result).toEqual({ sweptSessions: 2 });
    expect(redactSessionMock).toHaveBeenCalledTimes(2);
  });
});

// Thread-message inclusion in the content wipe (caseworker portal spec
// section 10 item 8): thread message bodies are wiped on the same cutoff
// clock as session message content.
describe('executeContentWipe thread-message inclusion', () => {
  const SETTINGS = {
    enabled: true,
    retention_hours: 24,
    wipe_time: '03:00',
    require_redaction_complete: true,
    last_wipe_at: null,
    last_wipe_count: 0,
  };

  function mockWipeRun(settings = SETTINGS) {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('SELECT config_value')) return Promise.resolve({ rows: [{ config_value: settings }] });
      if (s.includes('INSERT INTO content_wipe_log')) return Promise.resolve({ rows: [{ wipe_id: 'w1' }] });
      if (s.includes('UPDATE messages')) return Promise.resolve({ rows: [], rowCount: 5 });
      if (s.includes('SELECT COUNT(*)')) return Promise.resolve({ rows: [{ count: '2' }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('wipes thread message bodies on the same cutoff, passing the redaction-complete guard through', async () => {
    // A fixed ordinary day (the DST change days are covered below).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T18:00:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    mockWipeRun();
    wipeAgedThreadMessageBodiesMock.mockResolvedValue(4);

    const result = await executeContentWipe('manual', 'admin');

    expect(result.success).toBe(true);
    expect(result.messagesWiped).toBe(5);
    expect(result.threadBodiesWiped).toBe(4);
    expect(wipeAgedThreadMessageBodiesMock).toHaveBeenCalledTimes(1);
    const [cutoff, requireScanComplete] = wipeAgedThreadMessageBodiesMock.mock.calls[0];
    expect(cutoff).toBeInstanceOf(Date);
    // Same clock: cutoff is retention_hours ago (within test-run slack).
    const expectedMs = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs((cutoff as Date).getTime() - expectedMs)).toBeLessThan(60_000);
    expect(requireScanComplete).toBe(true);
  });

  it('passes require_redaction_complete=false through to the thread wipe', async () => {
    mockWipeRun({ ...SETTINGS, require_redaction_complete: false });

    await executeContentWipe('manual', 'admin');

    expect(wipeAgedThreadMessageBodiesMock).toHaveBeenCalledWith(expect.any(Date), false);
  });

  it('emits content:wiped to the researcher admin-broadcast room (not the dead "admin" room)', async () => {
    mockWipeRun();
    wipeAgedThreadMessageBodiesMock.mockResolvedValue(0);
    const emitMock = vi.fn();
    const toMock = vi.fn(() => ({ emit: emitMock }));
    (global as unknown as { io: unknown }).io = { to: toMock };
    try {
      await executeContentWipe('manual', 'admin');
      expect(toMock).toHaveBeenCalledWith('admin-broadcast');
      expect(emitMock).toHaveBeenCalledWith(
        'content:wiped',
        expect.objectContaining({ wipeId: 'w1', messagesWiped: 5, triggeredBy: 'manual' }),
      );
    } finally {
      (global as unknown as { io: unknown }).io = undefined;
    }
  });

  // The scheduler runs executeContentWipe from a bare setTimeout: a throw here
  // used to be an unhandled rejection AND skipped the reschedule, silently
  // killing the nightly wipe until the next deploy. It must never reject.
  it('resolves failure (never throws) when the running-log INSERT fails', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('SELECT config_value')) return Promise.resolve({ rows: [{ config_value: SETTINGS }] });
      if (s.includes('INSERT INTO content_wipe_log')) return Promise.reject(new Error('db down'));
      return Promise.resolve({ rows: [] });
    });

    const result = await executeContentWipe('scheduler');

    expect(result.success).toBe(false);
    expect(result.error).toBe('db down');
  });

  it('resolves failure (never throws) even when recording the failure also fails', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('SELECT config_value')) return Promise.resolve({ rows: [{ config_value: SETTINGS }] });
      if (s.includes('INSERT INTO content_wipe_log')) return Promise.resolve({ rows: [{ wipe_id: 'w1' }] });
      if (s.includes(`status = 'failed'`)) return Promise.reject(new Error('db still down'));
      if (s.includes('UPDATE messages')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (s.includes('SELECT COUNT(*)')) return Promise.resolve({ rows: [{ count: '0' }] });
      return Promise.resolve({ rows: [] });
    });
    wipeAgedThreadMessageBodiesMock.mockRejectedValue(new Error('db down'));

    const result = await executeContentWipe('scheduler');

    expect(result.success).toBe(false);
    expect(result.error).toBe('db down');
  });

  it('marks the wipe failed (not silently partial) when the thread wipe throws', async () => {
    mockWipeRun();
    wipeAgedThreadMessageBodiesMock.mockRejectedValue(new Error('db down'));

    const result = await executeContentWipe('manual', 'admin');

    expect(result.success).toBe(false);
    expect(result.error).toBe('db down');
    const failLog = queryMock.mock.calls.find((c) => String(c[0]).includes(`status = 'failed'`));
    expect(failLog).toBeTruthy();
  });
});

// ai-therapist-374: the cutoff is retention_hours of ELAPSED time before now.
// It used to be `cutoff.setHours(cutoff.getHours() - retention_hours)`, which
// counts LOCAL wall-clock hours: on a DST change day in a zone with DST a
// 24-hour retention cut 23 real hours back (content wiped an hour early,
// spring forward) or 25 (kept an hour late, fall back). Production containers
// run in UTC, where the two agree; a host with TZ set to a DST zone did not.
describe('executeContentWipe cutoff is elapsed time, across DST changes (ai-therapist-374)', () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  function mockSettings(retentionHours: number) {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('SELECT config_value')) {
        return Promise.resolve({
          rows: [
            {
              config_value: {
                enabled: true,
                retention_hours: retentionHours,
                wipe_time: '03:00',
                require_redaction_complete: true,
              },
            },
          ],
        });
      }
      if (s.includes('INSERT INTO content_wipe_log')) return Promise.resolve({ rows: [{ wipe_id: 'w1' }] });
      if (s.includes('UPDATE messages')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (s.includes('SELECT COUNT(*)')) return Promise.resolve({ rows: [{ count: '0' }] });
      return Promise.resolve({ rows: [] });
    });
  }

  /** Every cutoff the run used: the message wipe, the skipped count and the thread wipe. */
  function cutoffsUsed(): string[] {
    const fromQueries = queryMock.mock.calls
      .filter((c) => /UPDATE messages|SELECT COUNT\(\*\) as count FROM messages/.test(String(c[0])))
      .map((c) => (c[1] as unknown[])[0] as Date);
    const fromThreads = wipeAgedThreadMessageBodiesMock.mock.calls.map((c) => c[0] as Date);
    return [...fromQueries, ...fromThreads].map((d) => d.toISOString());
  }

  // 2027 changes in America/Denver: clocks go forward at 02:00 MST on
  // 2027-03-14 (09:00Z) and back at 02:00 MDT on 2027-11-07 (08:00Z).
  const cases = [
    // 03:30 MDT, an hour after clocks went forward: the old code gave 10:30Z (23 h).
    { day: 'spring-forward', now: '2027-03-14T09:30:00.000Z', expected: '2027-03-13T09:30:00.000Z' },
    // 01:30 MST, the second 01:30 of the night: the old code gave 07:30Z (25 h).
    { day: 'fall-back', now: '2027-11-07T08:30:00.000Z', expected: '2027-11-06T08:30:00.000Z' },
  ];

  for (const tz of ['America/Denver', 'UTC']) {
    for (const { day, now, expected } of cases) {
      it(`cuts off exactly 24 h of elapsed time on the 2027 ${day} day under TZ=${tz}`, async () => {
        process.env.TZ = tz;
        // The zone really applies in this process (Denver is UTC-6 in summer, UTC-7 in winter).
        if (tz === 'America/Denver') {
          expect(new Date('2027-07-01T12:00:00Z').getTimezoneOffset()).toBe(360);
          expect(new Date('2027-01-01T12:00:00Z').getTimezoneOffset()).toBe(420);
        } else {
          expect(new Date('2027-07-01T12:00:00Z').getTimezoneOffset()).toBe(0);
        }
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(now));
        mockSettings(24);

        const result = await executeContentWipe('manual', 'admin');

        expect(result.success).toBe(true);
        const used = cutoffsUsed();
        expect(used).toHaveLength(3);
        for (const c of used) expect(c).toBe(expected);
        expect(Date.parse(now) - Date.parse(expected)).toBe(24 * 3_600_000);
      });
    }
  }

  it('drops the remembered turns from before the same cutoff, after the wipe ran', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-06-10T12:00:00Z'));
    _resetRecentTurnsForTests();
    rememberTurn('s1', 'user', 'older than 24 h', { at: Date.parse('2027-06-09T11:59:59.999Z') });
    rememberTurn('s1', 'user', 'exactly 24 h', { at: Date.parse('2027-06-09T12:00:00Z') });
    rememberTurn('s1', 'user', 'recent', { at: Date.parse('2027-06-10T11:00:00Z') });
    mockSettings(24);

    expect((await executeContentWipe('manual', 'admin')).success).toBe(true);

    expect(recentTurns('s1')?.turns.map((t) => t.content)).toEqual(['exactly 24 h', 'recent']);
  });

  it('keeps the remembered turns when the wipe query fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-06-10T12:00:00Z'));
    _resetRecentTurnsForTests();
    rememberTurn('s1', 'user', 'older than 24 h', { at: Date.parse('2027-06-08T12:00:00Z') });
    mockSettings(24);
    const ok = queryMock.getMockImplementation()!;
    queryMock.mockImplementation((sql: string, params?: unknown[]) =>
      String(sql).includes('UPDATE messages') ? Promise.reject(new Error('boom')) : ok(sql, params),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect((await executeContentWipe('manual', 'admin')).success).toBe(false);

    expect(recentTurns('s1')?.turns).toHaveLength(1);
  });

  it('uses the same elapsed-time cutoff for the pending-wipe stat', async () => {
    process.env.TZ = 'America/Denver';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-14T09:30:00Z'));
    mockSettings(24);

    await getWipeStats();

    const pending = queryMock.mock.calls.find((c) => String(c[0]).includes('created_at < $1'));
    expect((pending?.[1] as Date[])[0].toISOString()).toBe('2027-03-13T09:30:00.000Z');
  });
});

// The fix must never make a wipe delete MORE than the old code did outside a
// DST change: rows are wiped when created_at < cutoff, so the new cutoff must
// never be later than the old one, and for the integer settings the admin UI
// offers it must be identical. The old arithmetic is reproduced here as the
// reference.
describe('retentionCutoff never widens the wipe outside a DST change', () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  function oldCutoff(retentionHours: number, nowMs: number): Date {
    const d = new Date(nowMs);
    d.setHours(d.getHours() - retentionHours);
    return d;
  }

  for (const tz of ['America/Denver', 'UTC']) {
    it(`matches the old wall-clock cutoff on ordinary days, every half hour for a week, under TZ=${tz}`, () => {
      process.env.TZ = tz;
      // 2027-06-07..14 is all MDT in Denver, and so is the same week a year
      // earlier, so no setting below spans a DST change.
      const start = Date.parse('2027-06-07T00:17:23.456Z');
      let compared = 0;
      for (let t = start; t < start + 7 * 24 * 3_600_000; t += 30 * 60_000) {
        for (const h of [1, 2, 23, 24, 25, 48, 72, 168, 8760]) {
          const old = oldCutoff(h, t);
          expect(old.getTimezoneOffset()).toBe(new Date(t).getTimezoneOffset());
          expect(retentionCutoff(h, t).getTime()).toBe(old.getTime());
          compared++;
        }
      }
      expect(compared).toBe(7 * 48 * 9);
    });

    it(`never cuts later than the old code for a fractional setting under TZ=${tz}`, () => {
      process.env.TZ = tz;
      const start = Date.parse('2027-06-07T00:17:23.456Z');
      for (let t = start; t < start + 24 * 3_600_000; t += 15 * 60_000) {
        for (const h of [1.5, 23.25, 24.9]) {
          expect(retentionCutoff(h, t).getTime()).toBeLessThanOrEqual(oldCutoff(h, t).getTime());
          expect(retentionCutoff(h, t).getTime()).toBe(t - Math.ceil(h) * 3_600_000);
        }
      }
    });
  }

  // What the old code did with 1.5: setHours truncates its argument toward
  // zero, so it cut 2 h back when the local hour was >= 2 (10 - 1.5 = 8.5 -> 8)
  // and 1 h back at local 00:xx or 01:xx (0 - 1.5 = -1.5 -> -1). Math.ceil cuts
  // 2 h back at every hour: never later than the old cutoff, so never more rows.
  it('records the old rounding of a fractional setting, and ceil is never later', () => {
    process.env.TZ = 'UTC';
    const at = (iso: string) => Date.parse(iso);
    const hoursBack = (d: Date, t: number) => (t - d.getTime()) / 3_600_000;
    expect(hoursBack(oldCutoff(1.5, at('2027-06-07T10:17:00Z')), at('2027-06-07T10:17:00Z'))).toBe(2);
    expect(hoursBack(oldCutoff(1.5, at('2027-06-07T00:17:00Z')), at('2027-06-07T00:17:00Z'))).toBe(1);
    expect(hoursBack(oldCutoff(1.5, at('2027-06-07T01:17:00Z')), at('2027-06-07T01:17:00Z'))).toBe(1);
    for (const iso of ['2027-06-07T10:17:00Z', '2027-06-07T00:17:00Z', '2027-06-07T01:17:00Z']) {
      expect(hoursBack(retentionCutoff(1.5, at(iso)), at(iso))).toBe(2);
    }
  });

  it('is exactly retention_hours of elapsed time before now', () => {
    const t = Date.parse('2027-03-14T09:30:00Z');
    expect(retentionCutoff(24, t).toISOString()).toBe('2027-03-13T09:30:00.000Z');
    expect(retentionCutoff(1, t).toISOString()).toBe('2027-03-14T08:30:00.000Z');
  });
});
