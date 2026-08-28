import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { findEndedSessionsWithRedactionGaps, sweepRedactionGaps, executeContentWipe } from './contentWipe.service.js';

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

  it('marks the wipe failed (not silently partial) when the thread wipe throws', async () => {
    mockWipeRun();
    wipeAgedThreadMessageBodiesMock.mockRejectedValue(new Error('db down'));

    const result = await executeContentWipe('manual', 'admin');

    expect(result.success).toBe(false);
    expect(result.error).toBe('db down');
    const failLog = queryMock.mock.calls.find(c => String(c[0]).includes(`status = 'failed'`));
    expect(failLog).toBeTruthy();
  });
});
