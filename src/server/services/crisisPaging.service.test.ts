// On-call paging policy (ai-therapist-350 / 349 / 320): one participant in one
// crisis produced four texts in 2.5 minutes. These tests pin each rule, with
// the pager and the database replaced by in-memory fakes: nothing here can
// page a person or touch a real table.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeRow {
  action_id: number;
  session_id: string;
  action_type: string;
  action_details: Record<string, unknown>;
  performed_at: Date;
}
interface FakeEvent {
  session_id: string;
  severity: string;
  risk_score: number;
  risk_factors: string[];
  created_at: Date;
  /** crisis_events.event_type; 'flagged' when omitted. */
  event_type?: string;
}

const { db, sendCrisisAlertMock, isSandboxMock, broadcastMock } = vi.hoisted(() => ({
  db: {
    /** session id -> owning participant (users.userid), null = anonymous.
     *  Insertion order is the order the sessions were started. */
    sessions: new Map<string, number | null>(),
    /** therapy_sessions.is_demo (harness and demo sessions). */
    demo: new Set<string>(),
    /** Make the silence-check claim throw (database trouble at claim time). */
    failClaims: false,
    /** Calls to claimSilenceCheck that won, as [action id, claimed by]. */
    claims: [] as Array<[number, string]>,
    rows: [] as FakeRow[],
    events: [] as FakeEvent[],
    /** risk_score_history: what the assessor scored a participant turn. */
    assessed: [] as Array<{ session_id: string; severity: string; risk_score: number; at: number }>,
    /** Participant turns: [session id, time]. */
    spoke: [] as Array<{ session_id: string; at: number }>,
    failLookups: false,
    hangLookups: false,
    nextId: 1,
  },
  sendCrisisAlertMock: vi.fn(),
  isSandboxMock: vi.fn(),
  broadcastMock: vi.fn(async () => undefined),
}));

const lookupGate = async (): Promise<void> => {
  if (db.failLookups) throw new Error('db down');
  if (db.hangLookups) await new Promise(() => undefined);
};

// The fake mirrors the WHERE clauses of db/paging.queries.ts.
vi.mock('../db/paging.queries.js', () => ({
  getPagingParticipantUserId: vi.fn(async (sessionId: string) => {
    await lookupGate();
    return db.sessions.get(sessionId) ?? null;
  }),
  getRecentPagingRecords: vi.fn(async (sessionId: string, userId: number | null, since: Date) => {
    await lookupGate();
    return db.rows
      .filter(
        (r) =>
          r.performed_at.getTime() >= since.getTime() &&
          'paging' in r.action_details &&
          (r.session_id === sessionId || (userId !== null && db.sessions.get(r.session_id) === userId)),
      )
      .sort((a, b) => b.performed_at.getTime() - a.performed_at.getTime());
  }),
  INCIDENT_CHAIN_BACKSTOP_MS: 12 * 60 * 60 * 1000,
  // A stamped session continues the same participant's session started just
  // before it; the walk stops at the first session that is not stamped.
  getIncidentChainSessionIds: vi.fn(async (sessionId: string, _backstop: Date) => {
    await lookupGate();
    const order = [...db.sessions.keys()];
    const chain = [sessionId];
    let current = sessionId;
    for (let depth = 0; depth < 25; depth++) {
      const owner = db.sessions.get(current) ?? null;
      const stamped = db.events.some(
        (e) => e.session_id === current && e.risk_factors.includes('recovery_continuation'),
      );
      if (owner === null || !stamped) break;
      const previous = order
        .slice(0, order.indexOf(current))
        .reverse()
        .find((id) => db.sessions.get(id) === owner);
      if (!previous) break;
      chain.push(previous);
      current = previous;
    }
    return chain;
  }),
  getParticipantFlagEvents: vi.fn(async (sessionIds: string[], userId: number | null, since: Date) => {
    await lookupGate();
    return db.events.filter(
      (e) =>
        ['flagged', 'risk_score_updated', 'severity_changed'].includes(e.event_type ?? 'flagged') &&
        !e.risk_factors.includes('recovery_continuation') &&
        (sessionIds.includes(e.session_id) ||
          (userId !== null && db.sessions.get(e.session_id) === userId && e.created_at.getTime() >= since.getTime())),
    );
  }),
  getParticipantAssessedRisk: vi.fn(async (sessionIds: string[], userId: number | null, since: Date) => {
    await lookupGate();
    return db.assessed
      .filter(
        (a) =>
          (a.severity === 'medium' || a.severity === 'high') &&
          (sessionIds.includes(a.session_id) ||
            (userId !== null && db.sessions.get(a.session_id) === userId && a.at >= since.getTime())),
      )
      .map((a) => ({ session_id: sessionIds[0], severity: a.severity, risk_score: a.risk_score }));
  }),
  // The three silence-check queries, with the WHERE clauses of the real ones.
  // The claim is check-and-set with no await in between, which is what the
  // single conditional UPDATE gives in Postgres.
  getUnfinishedSilenceChecks: vi.fn(async (lookbackSeconds: number, staleClaimSeconds: number) => {
    await lookupGate();
    const now = Date.now();
    return db.rows
      .filter((r) => {
        const p = r.action_details['paging'] as Record<string, unknown> | undefined;
        const check = p?.['silenceCheck'] as Record<string, unknown> | undefined;
        if (r.action_type !== 'external_api_called' || p?.['decision'] !== 'no_page' || !check) return false;
        if (db.demo.has(r.session_id) || now - r.performed_at.getTime() > lookbackSeconds * 1000) return false;
        return (
          check['state'] === 'pending' ||
          (check['state'] === 'running' &&
            now - new Date(String(check['claimedAt'])).getTime() > staleClaimSeconds * 1000)
        );
      })
      .sort((a, b) => a.performed_at.getTime() - b.performed_at.getTime())
      .map((r) => ({
        action_id: r.action_id,
        session_id: r.session_id,
        age_ms: now - r.performed_at.getTime(),
        attempts: Number(
          ((r.action_details['paging'] as Record<string, unknown>)['silenceCheck'] as Record<string, unknown>)[
            'attempts'
          ] ?? 0,
        ),
      }));
  }),
  claimSilenceCheck: vi.fn(async (actionId: number, claimedBy: string, staleClaimSeconds: number) => {
    if (db.failClaims) throw new Error('db down');
    const row = db.rows.find((r) => r.action_id === actionId);
    const p = row?.action_details['paging'] as Record<string, unknown> | undefined;
    const check = p?.['silenceCheck'] as Record<string, unknown> | undefined;
    const now = Date.now();
    const open =
      check?.['state'] === 'pending' ||
      (check?.['state'] === 'running' &&
        now - new Date(String(check['claimedAt'])).getTime() > staleClaimSeconds * 1000);
    if (!row || !p || p['decision'] !== 'no_page' || !open) return null;
    p['silenceCheck'] = { ...check, state: 'running', claimedAt: new Date(now).toISOString(), claimedBy };
    db.claims.push([actionId, claimedBy]);
    return {
      sessionId: row.session_id,
      cutAt: new Date(row.performed_at),
      attempts: Number(check?.['attempts'] ?? 0),
      isDemo: db.demo.has(row.session_id),
    };
  }),
  releaseSilenceCheck: vi.fn(async (actionId: number, result: Record<string, unknown>) => {
    const row = db.rows.find((r) => r.action_id === actionId);
    const p = row?.action_details['paging'] as Record<string, unknown> | undefined;
    const check = p?.['silenceCheck'] as Record<string, unknown> | undefined;
    if (!p || check?.['state'] !== 'running') return false;
    const { claimedAt: _a, claimedBy: _b, ...kept } = check;
    p['silenceCheck'] = { ...kept, ...result, state: 'pending' };
    return true;
  }),
  finishSilenceCheck: vi.fn(async (actionId: number, state: string, result: Record<string, unknown>) => {
    const row = db.rows.find((r) => r.action_id === actionId);
    const p = row?.action_details['paging'] as Record<string, unknown> | undefined;
    const check = p?.['silenceCheck'] as Record<string, unknown> | undefined;
    if (!p || (check?.['state'] !== 'pending' && check?.['state'] !== 'running')) return false;
    p['silenceCheck'] = { ...check, ...result, state, finishedAt: new Date().toISOString() };
    return true;
  }),
  participantSpokeSince: vi.fn(async (userId: number, since: Date) => {
    await lookupGate();
    return db.spoke.some((m) => db.sessions.get(m.session_id) === userId && m.at > since.getTime());
  }),
  insertPagingRecord: vi.fn(
    async (sessionId: string, actionType: string, details: Record<string, unknown>, _riskScore: number | null) => {
      const row: FakeRow = {
        action_id: db.nextId++,
        session_id: sessionId,
        action_type: actionType,
        // Through JSON, as the real column is JSONB.
        action_details: JSON.parse(JSON.stringify(details)) as Record<string, unknown>,
        performed_at: new Date(),
      };
      db.rows.push(row);
      return row.action_id;
    },
  ),
}));
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: sendCrisisAlertMock }));
vi.mock('./suppression.js', () => ({ sessionSuppressesCrisisPaging: isSandboxMock }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: broadcastMock }));

import {
  pageHighRisk,
  pageVendorTermination,
  pageCovers,
  priorPageFromRow,
  vendorCutLevel,
  riskPageLevel,
  buildRiskPageMessage,
  buildVendorCutMessage,
  runVendorCutSilenceCheck,
  runStoredSilenceCheck,
  sweepSilenceChecks,
  resolveIncidentPeak,
  VENDOR_CUT_SILENCE_CHECK_MS,
  SILENCE_CHECK_CEILING_MS,
  SILENCE_CHECK_STALE_CLAIM_MS,
  INCIDENT_LOOKBACK_MS,
  PAGE_FOLD_WINDOW_MS,
  PAGING_LOOKUP_TIMEOUT_MS,
  CRITICAL_RISK_SCORE,
  PAGE_LEVEL,
  _resetPagingStateForTests,
} from './crisisPaging.service.js';
import * as pagingQueries from '../db/paging.queries.js';

const T0 = new Date('2026-11-18T22:27:00-07:00').getTime();
const MIN = 60_000;

/** Move the clock (only Date is faked, so awaits and timers run normally). */
const at = (offsetMs: number): void => {
  vi.setSystemTime(new Date(T0 + offsetMs));
};

const session = (id: string, userId: number | null): string => {
  db.sessions.set(id, userId);
  return id;
};
const flag = (
  sessionId: string,
  severity: 'medium' | 'high',
  score: number,
  factors: string[] = [],
  eventType?: string,
): void => {
  db.events.push({
    session_id: sessionId,
    severity,
    risk_score: score,
    risk_factors: factors,
    created_at: new Date(),
    ...(eventType ? { event_type: eventType } : {}),
  });
};
/** What markSessionCrisisContinuation stamps on every recovery session. */
const continuation = (sessionId: string, inheritedScore: number): void =>
  flag(sessionId, 'high', inheritedScore, ['recovery_continuation']);

/** A participant turn the assessor scored, with no flag event of its own. */
const assessed = (sessionId: string, severity: 'low' | 'medium' | 'high', score: number): void => {
  db.assessed.push({ session_id: sessionId, severity, risk_score: score, at: Date.now() });
};

const speaks = (sessionId: string): void => {
  db.spoke.push({ session_id: sessionId, at: Date.now() });
};

const cut = (sessionId: string, row: { flagged: boolean; severity: string | null }) =>
  pageVendorTermination({ sessionId, cause: 'content_filter', ...row });

const texts = (): string[] => sendCrisisAlertMock.mock.calls.map((c) => String(c[0]));
const paging = (row: FakeRow): Record<string, unknown> => row.action_details['paging'] as Record<string, unknown>;
const rowsOf = (decision: string): FakeRow[] => db.rows.filter((r) => paging(r)['decision'] === decision);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  db.sessions.clear();
  db.demo.clear();
  db.failClaims = false;
  db.claims.length = 0;
  db.rows.length = 0;
  db.events.length = 0;
  db.assessed.length = 0;
  db.spoke.length = 0;
  db.failLookups = false;
  db.hangLookups = false;
  db.nextId = 1;
  sendCrisisAlertMock.mockReset().mockResolvedValue(true);
  isSandboxMock.mockReset().mockResolvedValue(false);
  broadcastMock.mockClear();
  (global as { io?: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
  _resetPagingStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete (global as { io?: unknown }).io;
});

describe('rule 1: the first page for a participant always sends', () => {
  it('a high risk flag pages, and the row says it was delivered', async () => {
    const s = session('live_u7_aaaaaaaaaaaaaaaa', 7);
    const decision = await pageHighRisk(s, 75);
    expect(decision.outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].action_type).toBe('crisis_sms_alert');
    expect(db.rows[0].action_details['riskScore']).toBe(75);
    expect(paging(db.rows[0])).toMatchObject({
      decision: 'paged',
      kind: 'risk',
      level: PAGE_LEVEL.high,
      delivered: true,
    });
  });

  it('a vendor cut on a high-risk session pages', async () => {
    const s = session('s1', 7);
    flag(s, 'high', 80);
    expect((await cut(s, { flagged: true, severity: 'high' })).outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('pages when every lookup fails (nothing known can absorb it)', async () => {
    const s = session('s1', 7);
    db.failLookups = true;
    expect((await pageHighRisk(s, 80)).outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a lookup that hangs does not hold the page back past the timeout', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const s = session('s1', 7);
    db.hangLookups = true;
    const pending = pageHighRisk(s, 80);
    await vi.advanceTimersByTimeAsync(PAGING_LOOKUP_TIMEOUT_MS + 50);
    expect((await pending).outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing sandbox check pages; only an affirmative sandbox=true suppresses', async () => {
    const s = session('s1', 7);
    isSandboxMock.mockRejectedValueOnce(new Error('db blip'));
    expect((await pageHighRisk(s, 80)).outcome).toBe('paged');

    const sbx = session('sbx', 99);
    isSandboxMock.mockResolvedValueOnce(true);
    expect((await pageHighRisk(sbx, 80)).outcome).toBe('sandbox');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });
});

describe('rule 2: same severity inside the window is folded, and recorded', () => {
  it('a repeat high flag in another session of the same participant is not sent again', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    const first = await pageHighRisk(s1, 80);
    at(2 * MIN);
    const second = await pageHighRisk(s2, 85);

    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ outcome: 'folded', foldedIntoActionId: first.actionId, foldedIntoSessionId: 's1' });

    const [folded] = rowsOf('folded');
    expect(folded.session_id).toBe('s2');
    expect(folded.action_type).toBe('external_api_called');
    expect(folded.action_details).toMatchObject({ suppressed: 'crisis_sms_alert', reason: 'folded_into_recent_page' });
    expect(paging(folded)).toMatchObject({
      foldedIntoActionId: first.actionId,
      foldedIntoSessionId: 's1',
      secondsAfterPage: 120,
      riskScore: 85,
    });
    expect(String(paging(folded)['summary'])).toMatch(/already paged 120 s earlier/);
  });

  it('the fold is shown to the admin dashboards', async () => {
    const s1 = session('s1', 7);
    await pageHighRisk(s1, 80);
    await pageHighRisk(s1, 82);
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.anything(),
      'session:page-decision',
      expect.objectContaining({ sessionId: 's1', outcome: 'folded', foldedIntoSessionId: 's1' }),
      's1',
    );
  });

  it('ai-therapist-320: the escalate tool at 80, then the pipeline at 88 for the same disclosure, is one page', async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 80);
    at(20_000);
    expect((await pageHighRisk(s, 88)).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('survives a restart: the stored row alone is enough to fold', async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 80);
    _resetPagingStateForTests();
    at(MIN);
    expect((await pageHighRisk(s, 80)).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('two events in the same instant produce one page (in-flight claim)', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    let release: (ok: boolean) => void = () => undefined;
    sendCrisisAlertMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)));

    const a = pageHighRisk(s1, 80);
    const b = pageHighRisk(s2, 80);
    await vi.waitFor(() => expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1));
    release(true);
    const [first, second] = await Promise.all([a, b]);

    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe('paged');
    expect(second).toMatchObject({ outcome: 'folded', foldedIntoActionId: first.actionId });
  });
});

describe('fail toward paging: only a DELIVERED page absorbs another', () => {
  it('a page that was not delivered does not absorb the next one', async () => {
    const s = session('s1', 7);
    sendCrisisAlertMock.mockResolvedValueOnce(false);
    expect((await pageHighRisk(s, 80)).outcome).toBe('not_delivered');
    expect(paging(db.rows[0])).toMatchObject({ decision: 'not_delivered', delivered: false });

    at(5_000);
    expect((await pageHighRisk(s, 80)).outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });

  it('an in-flight page that then fails releases the event waiting on it', async () => {
    const s = session('s1', 7);
    let release: (ok: boolean) => void = () => undefined;
    sendCrisisAlertMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = resolve)));

    const a = pageHighRisk(s, 80);
    const b = pageHighRisk(s, 80);
    await vi.waitFor(() => expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1));
    release(false);
    const [first, second] = await Promise.all([a, b]);

    expect(first.outcome).toBe('not_delivered');
    expect(second.outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });

  it('a pager that throws is an undelivered page, not an exception', async () => {
    const s = session('s1', 7);
    sendCrisisAlertMock.mockRejectedValueOnce(new Error('network'));
    await expect(pageHighRisk(s, 80)).resolves.toMatchObject({ outcome: 'not_delivered' });
  });

  it('rows written before this policy (no delivery mark) absorb nothing', () => {
    const legacy = {
      action_id: 1,
      session_id: 's1',
      action_type: 'crisis_sms_alert',
      action_details: { riskScore: 80 },
      performed_at: new Date(),
    };
    expect(priorPageFromRow(legacy)).toBeNull();
    expect(
      priorPageFromRow({
        ...legacy,
        action_details: { paging: { delivered: false, level: 2, kinds: ['risk'] } },
      }),
    ).toBeNull();
    expect(
      priorPageFromRow({
        ...legacy,
        action_type: 'external_api_called',
        action_details: { paging: { delivered: true, level: 2, kinds: ['risk'] } },
      }),
    ).toBeNull();
    // JSONB can arrive as a string from some drivers; still parsed.
    expect(
      priorPageFromRow({
        ...legacy,
        action_details: JSON.stringify({ paging: { delivered: true, level: 2, kinds: ['risk'], riskScore: 80 } }),
      }),
    ).toMatchObject({ level: 2, kinds: ['risk'], riskScore: 80 });
  });
});

describe('rule 3: an escalation pages at once, inside the window', () => {
  it('medium vendor cut, then a high flag: both page, the second marked as a follow-up', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    flag(s1, 'medium', 50);
    await cut(s1, { flagged: true, severity: 'medium' });
    at(97_000);
    const second = await pageHighRisk(s2, 75);

    expect(second.outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
    expect(texts()[1]).toMatch(/HIGH crisis flag/);
    expect(texts()[1]).toMatch(
      /Follow-up for the same participant: you were paged 2 min ago \(vendor filter ended a session\)/,
    );
  });

  it(`a score reaching ${CRITICAL_RISK_SCORE} after a lower high page pages again, labelled ESCALATED`, async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 75);
    at(3 * MIN);
    expect((await pageHighRisk(s, 86)).outcome).toBe('folded');
    at(4 * MIN);
    const third = await pageHighRisk(s, 95);
    expect(third.outcome).toBe('paged');
    expect(texts()[1]).toMatch(/\(ESCALATED\)/);
    expect(texts()[1]).toMatch(/RISK SCORE 95\/100 from what the participant said, up from 75 at the last page/);
    // And that level is itself only paged once per window.
    at(5 * MIN);
    expect((await pageHighRisk(s, 100)).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });

  it('the first vendor cut of a high-risk session pages even one second after the high-risk page', async () => {
    const s = session('s2', 7);
    flag(s, 'high', 75);
    await pageHighRisk(s, 75);
    at(1_000);
    const cutDecision = await cut(s, { flagged: true, severity: 'high' });
    expect(cutDecision.outcome).toBe('paged');
    expect(texts()[1]).toMatch(/ENDED BY THE VENDOR FILTER during a HIGH crisis flag/);
  });

  it('a high-risk vendor cut already paged covers a repeat high flag (it says the risk is high)', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    flag(s1, 'high', 80);
    await cut(s1, { flagged: true, severity: 'high' });
    at(30_000);
    expect((await pageHighRisk(s2, 80)).outcome).toBe('folded');
  });

  it('pure rule: level and kind', () => {
    const now = T0;
    const riskPage = { at: now - MIN, level: PAGE_LEVEL.high, kinds: ['risk' as const] };
    expect(pageCovers(riskPage, { kind: 'risk', level: PAGE_LEVEL.high }, now)).toBe(true);
    expect(pageCovers(riskPage, { kind: 'risk', level: PAGE_LEVEL.critical }, now)).toBe(false);
    expect(pageCovers(riskPage, { kind: 'vendor_cut', level: PAGE_LEVEL.high }, now)).toBe(false);
    expect(pageCovers(riskPage, { kind: 'vendor_cut', level: PAGE_LEVEL.mediumVendorCut }, now)).toBe(false);
    const cutPage = { at: now - MIN, level: PAGE_LEVEL.mediumVendorCut, kinds: ['vendor_cut' as const] };
    expect(pageCovers(cutPage, { kind: 'vendor_cut', level: PAGE_LEVEL.mediumVendorCut }, now)).toBe(true);
    expect(pageCovers(cutPage, { kind: 'vendor_cut', level: PAGE_LEVEL.high }, now)).toBe(false);
    expect(pageCovers(cutPage, { kind: 'risk', level: PAGE_LEVEL.high }, now)).toBe(false);
    expect(riskPageLevel(CRITICAL_RISK_SCORE - 1)).toBe(PAGE_LEVEL.high);
    expect(riskPageLevel(CRITICAL_RISK_SCORE)).toBe(PAGE_LEVEL.critical);
  });
});

describe('rule 5: a vendor cut is judged by the participant, not by the cut', () => {
  it('no risk signal: no SMS, a reviewable record and an admin notification', async () => {
    const s = session('s1', 7);
    const decision = await cut(s, { flagged: false, severity: null });

    expect(decision.outcome).toBe('no_page');
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].action_type).toBe('external_api_called');
    expect(db.rows[0].action_details).toMatchObject({
      suppressed: 'crisis_sms_alert',
      reason: 'vendor_cut_without_participant_risk',
    });
    expect(paging(db.rows[0])).toMatchObject({ decision: 'no_page', kind: 'vendor_cut', peakSeverity: 'none' });
    expect(broadcastMock).toHaveBeenCalledWith(
      expect.anything(),
      'session:page-decision',
      expect.objectContaining({ sessionId: 's1', outcome: 'no_page', kind: 'vendor_cut' }),
      's1',
    );
  });

  it('a recovery session is stamped high automatically: that stamp alone is not a risk signal', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    await cut(s1, { flagged: false, severity: null });
    continuation(s2, 100);
    at(60_000);
    // The row says flagged/high (the stamp); the participant said nothing risky.
    expect((await cut(s2, { flagged: true, severity: 'high' })).outcome).toBe('no_page');
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('medium: one SMS, worded as a vendor cut and NOT a high risk score', async () => {
    const s = session('live_u7_ElovAp3oMAnCoQLK', 7);
    flag(s, 'medium', 50);
    const decision = await cut(s, { flagged: true, severity: 'medium' });
    expect(decision).toMatchObject({ outcome: 'paged', level: PAGE_LEVEL.mediumVendorCut });
    expect(texts()[0]).toMatch(/VENDOR CUT, NOT a high risk score/);
    expect(texts()[0]).toMatch(/MEDIUM \(50\/100\), below the paging threshold/);
    expect(texts()[0]).not.toMatch(/URGENT/);
  });

  it('a recovery chain of a high-risk session is one page, however many times the vendor cuts it', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    const s3 = session('s3', 7);
    flag(s1, 'high', 80);
    const first = await cut(s1, { flagged: true, severity: 'high' });
    at(40_000);
    continuation(s2, 80);
    const second = await cut(s2, { flagged: true, severity: 'high' });
    at(80_000);
    continuation(s3, 80);
    const third = await cut(s3, { flagged: true, severity: 'high' });

    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe('paged');
    expect(second).toMatchObject({ outcome: 'folded', foldedIntoActionId: first.actionId });
    expect(third).toMatchObject({ outcome: 'folded', foldedIntoActionId: first.actionId });
    expect(rowsOf('folded').map((r) => r.session_id)).toEqual(['s2', 's3']);
  });

  it('a high flag in an earlier session of the incident still makes a later cut a high-risk cut', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    flag(s1, 'high', 80);
    at(40 * MIN); // outside any fold window; inside the incident lookback
    continuation(s2, 80);
    const decision = await cut(s2, { flagged: true, severity: 'high' });
    expect(decision).toMatchObject({ outcome: 'paged', level: PAGE_LEVEL.high });
  });

  it('an anonymous recovery session cannot be traced back, so its own flag stands and it pages', async () => {
    const s = session('anon-recovery', null);
    continuation(s, 100);
    expect((await cut(s, { flagged: true, severity: 'high' })).outcome).toBe('paged');
    expect(texts()[0]).toMatch(/HIGH crisis flag/);
  });

  it('unreadable risk is not "no risk": it pages at the lowest level and says so', async () => {
    const s = session('s1', 7);
    db.failLookups = true;
    const decision = await cut(s, { flagged: false, severity: null });
    expect(decision).toMatchObject({ outcome: 'paged', level: PAGE_LEVEL.mediumVendorCut });
    expect(texts()[0]).toMatch(/could NOT be read/);
  });

  it('a cut that lands before the turn is scored is reported on the high-risk page', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    expect((await cut(s1, { flagged: false, severity: null })).outcome).toBe('no_page');
    at(2_000);
    flag(s1, 'high', 85);
    expect((await pageHighRisk(s1, 85)).outcome).toBe('paged');
    expect(texts()[0]).toMatch(/Also: the voice vendor's content filter ended this participant's session 2 s ago/);
    // A cut of the session the on-call now knows is high risk is new: it
    // pages once, and the next one is folded.
    at(30_000);
    continuation(s2, 85);
    expect((await cut(s2, { flagged: true, severity: 'high' })).outcome).toBe('paged');
    at(60_000);
    expect((await cut(s2, { flagged: true, severity: 'high' })).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });

  it('the vendor ceiling during a high flag pages once per incident', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    const expire = (sessionId: string) =>
      pageVendorTermination({ sessionId, cause: 'expired', flagged: true, severity: 'high' });
    expect((await expire(s1)).outcome).toBe('paged');
    expect(texts()[0]).toMatch(/VENDOR SESSION LIMIT, not a new risk score/);
    at(5 * MIN);
    expect((await expire(s2)).outcome).toBe('folded');
  });

  it('pure rule: cut level by peak risk', () => {
    expect(vendorCutLevel('none')).toBeNull();
    expect(vendorCutLevel('medium')).toBe(PAGE_LEVEL.mediumVendorCut);
    expect(vendorCutLevel('unknown')).toBe(PAGE_LEVEL.mediumVendorCut);
    expect(vendorCutLevel('high')).toBe(PAGE_LEVEL.high);
  });
});

describe('a vendor cut that was not paged is checked again: did the participant come back?', () => {
  it('silent in every session since the cut: the on-call is paged then, and told why', async () => {
    const s1 = session('s1', 7);
    const cutAt = Date.now();
    expect((await cut(s1, { flagged: false, severity: null })).outcome).toBe('no_page');
    expect(paging(db.rows[0])['silenceCheckSeconds']).toBe(VENDOR_CUT_SILENCE_CHECK_MS / 1000);

    at(VENDOR_CUT_SILENCE_CHECK_MS);
    const decision = await runVendorCutSilenceCheck(s1, cutAt);
    expect(decision).toMatchObject({ outcome: 'paged', kind: 'vendor_cut', level: PAGE_LEVEL.mediumVendorCut });
    expect(texts()[0]).toMatch(/the participant has NOT come back/);
    expect(texts()[0]).toMatch(/VENDOR CUT, then 3 min of silence\. NOT a high risk score/);
    expect(paging(db.rows[1])).toMatchObject({ decision: 'paged', trigger: 'participant_silent_after_cut' });
  });

  it('spoke again in the recovery session: the pipeline is assessing them, nothing is sent', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    const cutAt = Date.now();
    await cut(s1, { flagged: false, severity: null });
    at(15_000);
    speaks(s2);
    at(VENDOR_CUT_SILENCE_CHECK_MS);
    expect(await runVendorCutSilenceCheck(s1, cutAt)).toBeNull();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('what they said BEFORE the cut, or what someone else said, does not count as coming back', async () => {
    const s1 = session('s1', 7);
    const other = session('o1', 8);
    speaks(s1);
    at(1_000);
    const cutAt = Date.now();
    await cut(s1, { flagged: false, severity: null });
    at(20_000);
    speaks(other);
    at(VENDOR_CUT_SILENCE_CHECK_MS + 1_000);
    expect((await runVendorCutSilenceCheck(s1, cutAt))?.outcome).toBe('paged');
  });

  it('fails toward paging: lookup failure, and an anonymous session that cannot be followed', async () => {
    const s1 = session('s1', 7);
    db.failLookups = true;
    expect((await runVendorCutSilenceCheck(s1, Date.now() - VENDOR_CUT_SILENCE_CHECK_MS))?.outcome).toBe('paged');

    db.failLookups = false;
    const anon = session('anon', null);
    speaks(anon);
    expect((await runVendorCutSilenceCheck(anon, Date.now() - VENDOR_CUT_SILENCE_CHECK_MS))?.outcome).toBe('paged');
  });

  it('several unpaged cuts in one recovery chain, participant silent throughout: one page', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    const t1 = Date.now();
    await cut(s1, { flagged: false, severity: null });
    at(30_000);
    const t2 = Date.now();
    continuation(s2, 100);
    await cut(s2, { flagged: true, severity: 'high' });
    at(VENDOR_CUT_SILENCE_CHECK_MS);
    expect((await runVendorCutSilenceCheck(s1, t1))?.outcome).toBe('paged');
    at(VENDOR_CUT_SILENCE_CHECK_MS + 30_000);
    expect((await runVendorCutSilenceCheck(s2, t2))?.outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('the check is scheduled by the cut itself', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const s1 = session('s1', 7);
    await cut(s1, { flagged: false, severity: null });
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS - 1_000);
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toMatch(/has NOT come back/);
  });

  it('a paged cut (medium or high) schedules no second check', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const s1 = session('s1', 7);
    flag(s1, 'medium', 50);
    await cut(s1, { flagged: true, severity: 'medium' });
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS * 2);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });
});

describe('a recovery session is stamped high, and that stamp must not hide a real disclosure', () => {
  // The pipeline re-flags an already-high session only when a score exceeds
  // the stored one by more than 10. A recovery session is stamped high at the
  // inherited score, or at 100 when the session it continues had no flag, so
  // a disclosure in it writes no 'flagged' event and asked for no page.
  it('no-risk cut, then a high turn in the recovery session: the on-call is paged for the turn', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    expect((await cut(s1, { flagged: false, severity: null })).outcome).toBe('no_page');
    at(10_000);
    continuation(s2, 100);
    at(40_000);
    speaks(s2);
    assessed(s2, 'high', 90);
    // Whether the session's high flag is only the stamp is decided, and the
    // disclosure recorded, by the pipeline (handleHighTurnWithoutReflag in
    // crisisPipeline.service, tested there); it then asks for this page.
    const trigger = { trigger: 'high_turn_in_recovery_session' };
    const decision = await pageHighRisk(s2, 90, trigger);
    expect(decision).toMatchObject({ outcome: 'paged', kind: 'risk', level: PAGE_LEVEL.critical });
    expect(texts()[0]).toMatch(/HIGH crisis flag\nWhy: RISK SCORE 90\/100 from what the participant said/);
    expect(paging(rowsOf('paged')[0])).toMatchObject({ trigger: 'high_turn_in_recovery_session', kind: 'risk' });
    // The next high turn says nothing new inside the window.
    at(60_000);
    expect((await pageHighRisk(s2, 92, trigger)).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('the cut of a recovery session is judged by what the assessor scored there, not only by flag events', async () => {
    const s1 = session('s1', 7);
    const s2 = session('s2', 7);
    await cut(s1, { flagged: false, severity: null });
    at(10_000);
    continuation(s2, 100);
    at(40_000);
    assessed(s2, 'low', 30);
    assessed(s2, 'high', 90);
    const decision = await cut(s2, { flagged: true, severity: 'high' });
    expect(decision).toMatchObject({ outcome: 'paged', level: PAGE_LEVEL.high });
    expect(texts()[0]).toMatch(/ENDED BY THE VENDOR FILTER during a HIGH crisis flag/);
    expect(texts()[0]).toMatch(/HIGH \(90\/100\)/);
  });

  it('a medium turn in a recovery session makes its cut a medium cut; a low one changes nothing', async () => {
    const s2 = session('s2', 7);
    continuation(s2, 100);
    assessed(s2, 'low', 30);
    expect((await cut(s2, { flagged: true, severity: 'high' })).outcome).toBe('no_page');
    assessed(s2, 'medium', 55);
    expect(await cut(s2, { flagged: true, severity: 'high' })).toMatchObject({
      outcome: 'paged',
      level: PAGE_LEVEL.mediumVendorCut,
    });
  });
});

describe('the silence check reports the risk as it stands when it runs', () => {
  it('the turn the filter cut on was scored high after the cut: the text does not say "nothing was flagged"', async () => {
    const s1 = session('s1', 7);
    const cutAt = Date.now();
    expect((await cut(s1, { flagged: false, severity: null })).outcome).toBe('no_page');
    at(2_000);
    flag(s1, 'high', 85);
    expect((await pageHighRisk(s1, 85)).outcome).toBe('paged');

    at(VENDOR_CUT_SILENCE_CHECK_MS);
    const decision = await runVendorCutSilenceCheck(s1, cutAt);
    // "They are at high risk AND gone" is new: not folded into the risk page.
    expect(decision).toMatchObject({ outcome: 'paged', kind: 'vendor_cut', level: PAGE_LEVEL.high });
    expect(texts()[1]).toMatch(/^URGENT: .*at HIGH risk, and the participant has NOT come back/);
    expect(texts()[1]).toMatch(/Their risk is HIGH \(85\/100\)/);
    expect(texts()[1]).not.toMatch(/nothing they said was flagged|NOT a high risk score/);
    expect(paging(db.rows[db.rows.length - 1])).toMatchObject({ peakSeverity: 'high', riskScore: 85 });
  });

  it('unreadable risk at check time is said to be unreadable', async () => {
    const s1 = session('s1', 7);
    db.failLookups = true;
    const decision = await runVendorCutSilenceCheck(s1, Date.now() - VENDOR_CUT_SILENCE_CHECK_MS);
    expect(decision?.outcome).toBe('paged');
    expect(texts()[0]).toMatch(/could NOT be read/);
    expect(texts()[0]).not.toMatch(/nothing they said was flagged/);
  });
});

describe('the window', () => {
  it('a page time-stamped in the future (database clock ahead of the app) absorbs nothing', () => {
    const now = T0;
    const future = { at: now + 30_000, level: PAGE_LEVEL.high, kinds: ['risk' as const] };
    expect(pageCovers(future, { kind: 'risk', level: PAGE_LEVEL.high }, now)).toBe(false);
    const edge = { at: now - PAGE_FOLD_WINDOW_MS, level: PAGE_LEVEL.high, kinds: ['risk' as const] };
    expect(pageCovers(edge, { kind: 'risk', level: PAGE_LEVEL.high }, now)).toBe(false);
    expect(pageCovers({ ...edge, at: edge.at + 1 }, { kind: 'risk', level: PAGE_LEVEL.high }, now)).toBe(true);
  });

  it('after the window the same severity pages again', async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 80);
    at(PAGE_FOLD_WINDOW_MS - 1_000);
    expect((await pageHighRisk(s, 80)).outcome).toBe('folded');
    at(PAGE_FOLD_WINDOW_MS + 1_000);
    expect((await pageHighRisk(s, 80)).outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });

  it('folded events do not extend the window (a continuing crisis is not silenced)', async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 80);
    for (const minute of [4, 8, 12, 14]) {
      at(minute * MIN);
      expect((await pageHighRisk(s, 80)).outcome).toBe('folded');
    }
    at(16 * MIN);
    expect((await pageHighRisk(s, 80)).outcome).toBe('paged');
  });

  it('is 15 minutes: the on-call acknowledgement target in docs/on-call-sop.md', () => {
    expect(PAGE_FOLD_WINDOW_MS).toBe(15 * MIN);
  });
});

describe('participants are never folded into each other', () => {
  it('two logged-in participants at the same moment both page', async () => {
    const a = session('sa', 7);
    const b = session('sb', 8);
    expect((await pageHighRisk(a, 80)).outcome).toBe('paged');
    expect((await pageHighRisk(b, 80)).outcome).toBe('paged');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
    expect(rowsOf('folded')).toHaveLength(0);
  });

  it('two anonymous sessions are two participants', async () => {
    const a = session('anon-a', null);
    const b = session('anon-b', null);
    await pageHighRisk(a, 80);
    expect((await pageHighRisk(b, 80)).outcome).toBe('paged');
    // The same anonymous session still de-duplicates against itself.
    expect((await pageHighRisk(a, 82)).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });

  it("one participant's vendor cut does not absorb another's", async () => {
    const a = session('sa', 7);
    const b = session('sb', 8);
    flag(a, 'high', 80);
    flag(b, 'high', 80);
    await cut(a, { flagged: true, severity: 'high' });
    expect((await cut(b, { flagged: true, severity: 'high' })).outcome).toBe('paged');
  });
});

describe('the on-call can tell the pages apart', () => {
  const ctx = { previousPage: null, unpagedCut: null, now: T0 };

  it('risk score vs vendor cut vs vendor cut at medium', () => {
    const risk = buildRiskPageMessage('live_u7_Eloycp3oMNHnVh9M', 75, ctx);
    const cutHigh = buildVendorCutMessage('live_u7_Eloycp3oMNHnVh9M', { severity: 'high', riskScore: 75 }, ctx);
    const cutMedium = buildVendorCutMessage('live_u7_Eloycp3oMNHnVh9M', { severity: 'medium', riskScore: 50 }, ctx);

    expect(risk).toMatch(
      /^URGENT: AI-Therapist HIGH crisis flag\nWhy: RISK SCORE 75\/100 from what the participant said\./,
    );
    expect(cutHigh).toMatch(/Why: VENDOR CUT, not a new risk score\..*risk before the cut was HIGH \(75\/100\)/);
    expect(cutMedium).toMatch(/Why: VENDOR CUT, NOT a high risk score\./);
    for (const text of [risk, cutHigh, cutMedium]) {
      expect(text).toMatch(/\/admin#session=live_u7_Eloycp3oMNHnVh9M$/);
      expect(text).toMatch(/Session live_u7_Eloycp3o\.\.\./);
    }
  });
});

describe('the stage voice test of 2026-11-18 (four texts in 2.5 minutes)', () => {
  const S1 = 'live_u7_ElovAp3oMAnCoQLKWeqEZIendoORid6Q';
  const S2 = 'live_u7_Eloycp3oMNHnVh9Mbc3aJPre15ZYP9jZ';
  const S3 = 'live_u7_Elp0Cp3oNKLSheq4GUfDcUDUVXb6xV23';

  it('as it happened (session 1 over-read to medium 50): three texts, each saying something new', async () => {
    for (const s of [S1, S2, S3]) session(s, 7);

    // 22:27:42 medium 50; 22:27:55 the filter ends session 1.
    at(42_000);
    flag(S1, 'medium', 50);
    at(55_000);
    const p1 = await cut(S1, { flagged: true, severity: 'medium' });

    // 22:27:58 recovery session 2 (stamped high, inherits 50); 22:29:32 risk 75.
    at(58_000);
    continuation(S2, 50);
    at(152_000);
    flag(S2, 'high', 75);
    const p2 = await pageHighRisk(S2, 75);

    // 22:29:33 the filter ends session 2, one second later.
    at(153_000);
    const p3 = await cut(S2, { flagged: true, severity: 'high' });

    // 22:29:36 recovery session 3; 22:30:15 the filter ends it too.
    at(156_000);
    continuation(S3, 75);
    at(195_000);
    const p4 = await cut(S3, { flagged: true, severity: 'high' });

    expect([p1.outcome, p2.outcome, p3.outcome, p4.outcome]).toEqual(['paged', 'paged', 'paged', 'folded']);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(3);
    expect(texts()[0]).toMatch(/VENDOR CUT, NOT a high risk score/);
    expect(texts()[1]).toMatch(/RISK SCORE 75\/100/);
    expect(texts()[2]).toMatch(/ENDED BY THE VENDOR FILTER during a HIGH crisis flag/);
    expect(p4.foldedIntoActionId).toBe(p3.actionId);
    // Four events, four rows: nothing is invisible in review.
    expect(db.rows).toHaveLength(4);
  });

  it('with session 1 scored correctly (no risk signal): two texts, and none for session 1', async () => {
    for (const s of [S1, S2, S3]) session(s, 7);

    at(55_000);
    const cutAt = Date.now();
    const p1 = await cut(S1, { flagged: false, severity: null });
    at(58_000);
    continuation(S2, 100);
    at(70_000);
    speaks(S2); // 22:28:10 "Wait, hello"
    at(152_000);
    flag(S2, 'high', 75);
    const p2 = await pageHighRisk(S2, 75);
    at(153_000);
    const p3 = await cut(S2, { flagged: true, severity: 'high' });
    at(156_000);
    continuation(S3, 75);
    at(195_000);
    const p4 = await cut(S3, { flagged: true, severity: 'high' });

    expect([p1.outcome, p2.outcome, p3.outcome, p4.outcome]).toEqual(['no_page', 'paged', 'paged', 'folded']);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
    // The first text is about the participant's risk, and mentions the cut
    // nobody was paged for; the second is the cut of the high-risk session.
    expect(texts()[0]).toMatch(/RISK SCORE 75\/100/);
    expect(texts()[0]).toMatch(/Also: the voice vendor's content filter ended this participant's session 2 min ago/);
    expect(texts()[1]).toMatch(/ENDED BY THE VENDOR FILTER during a HIGH crisis flag/);
    expect(db.rows).toHaveLength(4);
    // 22:30:55, the 3-minute check on session 1's cut: they came back, so nothing more.
    at(55_000 + VENDOR_CUT_SILENCE_CHECK_MS);
    expect(await runVendorCutSilenceCheck(S1, cutAt)).toBeNull();
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// ai-therapist-362: the silence check is owed by the stored row, not by the
// process that saw the cut. `restart()` is what a restart or deploy does to
// the process: every armed timer and the in-process ledger are gone, and only
// the rows remain. The startup sweep is then run by hand, as index.ts does
// through the safety backstop (messageSafety.service runSafetyBackstopPass).
// ---------------------------------------------------------------------------
describe('ai-therapist-362: the silence check survives a restart', () => {
  const restart = (): void => _resetPagingStateForTests();
  const check = (row: FakeRow): Record<string, unknown> => paging(row)['silenceCheck'] as Record<string, unknown>;
  const SEC = 1000;

  beforeEach(() => {
    // Real fake timers here: the timers are what is under test.
    vi.useRealTimers();
    vi.useFakeTimers();
    at(0);
  });

  /** A no-risk vendor cut for participant 7; returns its stored row. */
  const unpagedCut = async (id = 's1'): Promise<FakeRow> => {
    const decision = await cut(session(id, 7), { flagged: false, severity: null });
    expect(decision.outcome).toBe('no_page');
    return db.rows.find((r) => r.action_id === decision.actionId) as FakeRow;
  };

  it('the cut writes the check it owes onto its own row', async () => {
    const row = await unpagedCut();
    expect(check(row)).toEqual({ state: 'pending' });
    expect(paging(row)['summary']).toMatch(/On-call is paged in 3 min if the participant has not spoken again/);
  });

  it('the bug: a restart inside the 3 minutes, with nothing reading the rows, pages nobody', async () => {
    const row = await unpagedCut();
    await vi.advanceTimersByTimeAsync(60 * SEC);
    restart();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(check(row)['state']).toBe('pending');
  });

  it('restart at 1 min: the startup sweep re-arms from the row and the page goes out at 3 min, not later', async () => {
    const row = await unpagedCut();
    await vi.advanceTimersByTimeAsync(60 * SEC);
    restart();
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 1, expired: 0 });

    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS - 60 * SEC - 1 * SEC);
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * SEC);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toMatch(/VENDOR CUT, then 3 min of silence/);
    const page = rowsOf('paged')[0];
    expect(check(row)).toMatchObject({ state: 'done', outcome: 'paged', pageActionId: page.action_id });
  });

  it('down across the due time: the startup sweep runs the overdue check at once', async () => {
    const row = await unpagedCut();
    await vi.advanceTimersByTimeAsync(100 * SEC);
    restart();
    await vi.advanceTimersByTimeAsync(140 * SEC); // the process is back 4 min after the cut
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toMatch(/then 4 min of silence/);
    expect(check(row)).toMatchObject({ state: 'done', outcome: 'paged' });
  });

  it('the participant came back before the restart: the check runs, records that, and sends nothing', async () => {
    const row = await unpagedCut();
    await vi.advanceTimersByTimeAsync(20 * SEC);
    speaks(session('s2', 7));
    restart();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(check(row)).toMatchObject({ state: 'done', outcome: 'participant_spoke', pageActionId: null });
  });

  it('a check that ran is recorded and never runs twice, whoever asks', async () => {
    const row = await unpagedCut();
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(check(row)['state']).toBe('done');

    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
    expect(await runStoredSilenceCheck(row.action_id)).toBe('not_claimed');
    restart();
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(db.claims).toHaveLength(1);
  });

  it('two app instances (blue-green deploy) reach the same due check: one runs it, one page', async () => {
    const row = await unpagedCut();
    restart();
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + 5 * SEC);
    // Both instances sweep in the same instant, and a third path asks by id.
    const results = await Promise.all([
      sweepSilenceChecks(),
      sweepSilenceChecks(),
      runStoredSilenceCheck(row.action_id),
    ]);
    const ran =
      (results[0] as { ran: number }).ran + (results[1] as { ran: number }).ran + (results[2] === 'ran' ? 1 : 0);
    expect(ran).toBe(1);
    expect(db.claims).toHaveLength(1);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(rowsOf('paged')).toHaveLength(1);
  });

  it('the old instance still has its timer and the new one swept: still one check', async () => {
    const row = await unpagedCut(); // the old instance keeps its timer (no restart)
    await vi.advanceTimersByTimeAsync(60 * SEC);
    // The new instance starts and re-arms from the row. In this test both
    // instances share one timer table, so the second arm is a no-op; the
    // claim is what keeps two real processes to one run (test above).
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(check(row)['state']).toBe('done');
  });

  it('a duplicate run folds into the silence page that was already delivered', async () => {
    const row = await unpagedCut();
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    const firstPage = rowsOf('paged')[0];
    // The first run paged but its "done" mark was lost (the instance died
    // between the send and the update): the row still says running, stale.
    paging(row)['silenceCheck'] = {
      state: 'running',
      claimedAt: new Date(Date.now() - SILENCE_CHECK_STALE_CLAIM_MS - SEC).toISOString(),
      claimedBy: 'dead-instance',
    };
    restart();
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(check(row)).toMatchObject({ state: 'done', outcome: 'folded', foldedIntoActionId: firstPage.action_id });
    expect(paging(rowsOf('folded')[0])).toMatchObject({ foldedIntoActionId: firstPage.action_id });
  });

  it('a claim is left alone while it is fresh, and retried once its instance is taken for dead', async () => {
    const row = await unpagedCut();
    restart();
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS);
    paging(row)['silenceCheck'] = {
      state: 'running',
      claimedAt: new Date().toISOString(),
      claimedBy: 'other-instance',
    };
    await vi.advanceTimersByTimeAsync(SILENCE_CHECK_STALE_CLAIM_MS - 5 * SEC);
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * SEC);
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a check that fails unexpectedly keeps its claim, and the next sweep after the stale window retries it', async () => {
    const row = await unpagedCut();
    restart();
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    // A malformed history row makes the dispatch throw (as in the outer-catch tests).
    vi.mocked(pagingQueries.getRecentPagingRecords).mockResolvedValueOnce([null as never]);
    expect(await runStoredSilenceCheck(row.action_id)).toBe('failed');
    expect(check(row)['state']).toBe('running');
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SILENCE_CHECK_STALE_CLAIM_MS + SEC);
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it(`found later than the ${SILENCE_CHECK_CEILING_MS / MIN}-minute ceiling: no page, but marked expired and shown to admins`, async () => {
    const row = await unpagedCut();
    restart();
    await vi.advanceTimersByTimeAsync(SILENCE_CHECK_CEILING_MS + MIN);
    broadcastMock.mockClear();
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 1 });
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(check(row)).toMatchObject({ state: 'expired', outcome: 'not_run', reason: 'older_than_ceiling' });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(broadcastMock.mock.calls[0])).toMatch(/Silence check NOT run/);
    // And only once, however many sweeps follow.
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('just inside the ceiling it still pages', async () => {
    await unpagedCut();
    restart();
    await vi.advanceTimersByTimeAsync(SILENCE_CHECK_CEILING_MS - MIN);
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(texts()[0]).toMatch(/then 14 min of silence/);
  });

  it('sweeping repeatedly before the check is due arms it once', async () => {
    await unpagedCut();
    restart();
    await vi.advanceTimersByTimeAsync(30 * SEC);
    expect((await sweepSilenceChecks()).armed).toBe(1);
    expect((await sweepSilenceChecks()).armed).toBe(0);
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('never taken over by a sweep: harness and demo sessions, and rows from before the check was stored', async () => {
    const harness = await unpagedCut('harness1');
    db.demo.add('harness1');
    const legacy: FakeRow = {
      action_id: db.nextId++,
      session_id: session('old1', 9),
      action_type: 'external_api_called',
      action_details: { paging: { decision: 'no_page', kind: 'vendor_cut', delivered: false } },
      performed_at: new Date(),
    };
    db.rows.push(legacy);
    restart();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(check(harness)['state']).toBe('pending');
    expect(await runStoredSilenceCheck(legacy.action_id)).toBe('not_claimed');
  });

  it('the process that recorded a harness cut still runs its own check (its pager is neutered by the harness)', async () => {
    const row = await unpagedCut('harness2');
    db.demo.add('harness2');
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(check(row)['state']).toBe('done');
  });

  it('if the claim cannot be written the timer runs the check anyway (fail toward paging)', async () => {
    await unpagedCut();
    db.failClaims = true;
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    // The sweep has nobody to fall back for: it leaves the row for next time.
    expect(await runStoredSilenceCheck(db.rows[0].action_id)).toBe('unclaimed');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a cut whose row could not be written keeps an in-process check', async () => {
    vi.mocked(pagingQueries.insertPagingRecord).mockRejectedValueOnce(new Error('db down'));
    const decision = await cut(session('s1', 7), { flagged: false, severity: null });
    expect(decision).toMatchObject({ outcome: 'no_page', actionId: null });
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });

  it('a silence page that no channel accepted stays owed: retried on the next sweep, attempts counted', async () => {
    const row = await unpagedCut();
    sendCrisisAlertMock.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(check(row)).toMatchObject({ state: 'pending', attempts: 1, lastOutcome: 'not_delivered' });
    expect(check(row)['claimedBy']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3 * MIN); // the next backstop tick
    expect(await sweepSilenceChecks()).toEqual({ ran: 1, armed: 0, expired: 0 });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(2);
    expect(check(row)).toMatchObject({ state: 'done', outcome: 'paged', attempts: 1 });
    expect(rowsOf('not_delivered')).toHaveLength(1);
    expect(rowsOf('paged')).toHaveLength(1);
  });

  it('a silence page never delivered by the ceiling expires saying the on-call has NOT been told', async () => {
    const row = await unpagedCut();
    sendCrisisAlertMock.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    for (let tick = 0; tick < 3; tick++) {
      await vi.advanceTimersByTimeAsync(3 * MIN);
      await sweepSilenceChecks();
    }
    const attempts = sendCrisisAlertMock.mock.calls.length;
    expect(attempts).toBeGreaterThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(3 * MIN); // past the ceiling
    broadcastMock.mockClear();
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 1 });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(attempts);
    expect(check(row)).toMatchObject({ state: 'expired', outcome: 'not_delivered', attempts });
    expect(JSON.stringify(broadcastMock.mock.calls[0])).toMatch(/NOT DELIVERED.*has NOT been told/);
  });

  it('an undelivered check of a harness session is recorded as done: no sweep would ever retry it', async () => {
    const row = await unpagedCut('harness3');
    db.demo.add('harness3');
    sendCrisisAlertMock.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(VENDOR_CUT_SILENCE_CHECK_MS + SEC);
    expect(check(row)).toMatchObject({ state: 'done', outcome: 'not_delivered' });
  });

  it('a sweep that cannot read the table does nothing and does not throw', async () => {
    await unpagedCut();
    restart();
    db.failLookups = true;
    expect(await sweepSilenceChecks()).toEqual({ ran: 0, armed: 0, expired: 0 });
  });
});

// ---------------------------------------------------------------------------
// PR #64 review follow-ups
// ---------------------------------------------------------------------------
describe('the incident follows the recovery chain, not only the clock', () => {
  it('a real high flag, then a recovery session cut 2 h 20 min later, is a HIGH cut (was "none")', async () => {
    const s1 = session('s1', 7);
    flag(s1, 'high', 82);
    at(5 * MIN);
    const s2 = session('s2', 7);
    continuation(s2, 82);
    at(INCIDENT_LOOKBACK_MS + 20 * MIN);
    expect(await resolveIncidentPeak(s2, { flagged: true, severity: 'high' })).toEqual({
      severity: 'high',
      riskScore: 82,
    });
    const decision = await cut(s2, { flagged: true, severity: 'high' });
    expect(decision).toMatchObject({ outcome: 'paged', kind: 'vendor_cut', level: PAGE_LEVEL.high });
    expect(texts()[0]).toMatch(/ENDED BY THE VENDOR FILTER during a HIGH crisis flag/);
    expect(texts()[0]).toMatch(/HIGH \(82\/100\)/);
  });

  it('through several recovery sessions, and through what the assessor scored without a flag', async () => {
    const s1 = session('s1', 7);
    assessed(s1, 'high', 79);
    at(10 * MIN);
    const s2 = session('s2', 7);
    continuation(s2, 100);
    at(70 * MIN);
    const s3 = session('s3', 7);
    continuation(s3, 100);
    at(INCIDENT_LOOKBACK_MS + 40 * MIN);
    expect(await resolveIncidentPeak(s3, { flagged: true, severity: 'high' })).toEqual({
      severity: 'high',
      riskScore: 79,
    });
  });

  it('the time bound still decides for sessions no chain links', async () => {
    const earlier = session('earlier', 7);
    flag(earlier, 'high', 88);
    // A new session of their own (not a recovery session), inside 2 h: same incident.
    at(INCIDENT_LOOKBACK_MS - 10 * MIN);
    const sameEvening = session('same-evening', 7);
    expect((await resolveIncidentPeak(sameEvening, { flagged: false, severity: null })).severity).toBe('high');
    // Past 2 h and not linked: not this incident.
    at(INCIDENT_LOOKBACK_MS + 20 * MIN);
    const later = session('later', 7);
    expect(await resolveIncidentPeak(later, { flagged: false, severity: null })).toEqual({
      severity: 'none',
      riskScore: null,
    });
    expect((await cut(later, { flagged: false, severity: null })).outcome).toBe('no_page');
  });

  it("another participant's sessions are never part of the chain", async () => {
    const theirs = session('theirs', 8);
    flag(theirs, 'high', 95);
    const mine = session('mine', 7);
    continuation(mine, 100);
    expect((await resolveIncidentPeak(mine, { flagged: true, severity: 'high' })).severity).toBe('none');
  });
});

describe('staff revising the risk by hand counts toward the peak', () => {
  it('a researcher raised the session to high: its cut is a HIGH cut', async () => {
    const s = session('s1', 7);
    flag(s, 'high', 85, [], 'risk_score_updated');
    expect((await cut(s, { flagged: true, severity: 'high' })).level).toBe(PAGE_LEVEL.high);
  });

  it('severity_changed to medium counts as medium; a revision downward does not lower the peak', async () => {
    const s = session('s1', 7);
    flag(s, 'medium', 55, [], 'severity_changed');
    expect(await resolveIncidentPeak(s, { flagged: true, severity: 'medium' })).toEqual({
      severity: 'medium',
      riskScore: 55,
    });
    flag(s, 'high', 80);
    flag(s, 'medium', 40, [], 'risk_score_updated');
    expect(await resolveIncidentPeak(s, { flagged: true, severity: 'medium' })).toEqual({
      severity: 'high',
      riskScore: 80,
    });
  });

  it('other event types (an unflag, an intervention) are not risk signals', async () => {
    const s = session('s1', 7);
    flag(s, 'high', 85, [], 'unflagged');
    flag(s, 'high', 85, [], 'intervention_triggered');
    expect((await resolveIncidentPeak(s, { flagged: false, severity: null })).severity).toBe('none');
  });
});

describe('the lookups before a first page run together', () => {
  it('sandbox check and history lookup both hanging cost one timeout, not two', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const s = session('s1', 7);
    db.hangLookups = true;
    isSandboxMock.mockImplementation(() => new Promise(() => undefined));
    const pending = pageHighRisk(s, 80);
    await vi.advanceTimersByTimeAsync(PAGING_LOOKUP_TIMEOUT_MS + 50);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect((await pending).outcome).toBe('paged');
  });

  it('a vendor cut with every lookup hanging pages after two timeouts (risk, then the dispatch), not three', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const s = session('s1', 7);
    db.hangLookups = true;
    isSandboxMock.mockImplementation(() => new Promise(() => undefined));
    const pending = cut(s, { flagged: true, severity: 'high' });
    await vi.advanceTimersByTimeAsync(PAGING_LOOKUP_TIMEOUT_MS + 50);
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PAGING_LOOKUP_TIMEOUT_MS + 50);
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect((await pending).outcome).toBe('paged');
  });

  it('a sandbox session is still suppressed, and still writes its row', async () => {
    const s = session('s1', 7);
    isSandboxMock.mockResolvedValue(true);
    expect((await pageHighRisk(s, 80)).outcome).toBe('sandbox');
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rowsOf('sandbox')).toHaveLength(1));
  });
});

describe('what the page says (review wording)', () => {
  const ctx = { previousPage: null, unpagedCut: null, now: T0 };

  it('a medium vendor cut says the answer may be what was lost, and to consider reaching out', async () => {
    const s = session('live_u7_Eloycp3oMNHnVh9M', 7);
    flag(s, 'medium', 55);
    await cut(s, { flagged: true, severity: 'medium' });
    expect(texts()[0]).toMatch(/Why: VENDOR CUT, NOT a high risk score\. Risk before the cut was MEDIUM \(55\/100\)/);
    expect(texts()[0]).toMatch(/the participant's answer may be what was lost/);
    expect(texts()[0]).toMatch(/Review the transcript and consider reaching out\./);
    const unknown = buildVendorCutMessage('s', { severity: 'unknown', riskScore: null }, ctx);
    expect(unknown).toMatch(/could NOT be read/);
    expect(unknown).toMatch(/consider reaching out/);
    expect(unknown).not.toMatch(/may be what was lost/);
  });

  it("the model's escalate tool: the page does not claim the score came from the participant's words", async () => {
    const s = session('s1', 7);
    const decision = await pageHighRisk(s, 80, { source: 'model_escalation' });
    expect(decision.outcome).toBe('paged');
    expect(texts()[0]).toMatch(/^URGENT: AI-Therapist HIGH crisis flag\nWhy: RISK SCORE 80\/100 set by the ASSISTANT/);
    expect(texts()[0]).toMatch(/not a score of the participant's words\./);
    expect(texts()[0]).not.toMatch(/from what the participant said/);
    expect(paging(db.rows[0])).toMatchObject({ kind: 'risk', source: 'model_escalation' });
    expect(String(paging(db.rows[0])['summary'])).toMatch(/assistant's escalate tool/);
  });

  it('a flag from the pipeline still says "from what the participant said", and records its source', async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 80);
    expect(texts()[0]).toMatch(/Why: RISK SCORE 80\/100 from what the participant said\./);
    expect(paging(db.rows[0])).toMatchObject({ source: 'participant_turn' });
  });

  it('ai-therapist-320 still holds: the tool at 80 then the pipeline at 88 is one page, whichever wording went', async () => {
    const s = session('s1', 7);
    await pageHighRisk(s, 80, { source: 'model_escalation' });
    expect((await pageHighRisk(s, 88)).outcome).toBe('folded');
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
  });
});

describe('the last line of defence: an unexpected error inside the policy still pages', () => {
  // A history row that is not a row at all makes the decision itself throw,
  // past every inner guard. Both entry points then send directly.
  const breakDispatch = (): void => {
    vi.mocked(pagingQueries.getRecentPagingRecords).mockResolvedValueOnce([null as never]);
  };

  it('pageHighRisk: sends the risk page directly, with no row', async () => {
    const s = session('live_u7_aaaaaaaaaaaaaaaa', 7);
    breakDispatch();
    const decision = await pageHighRisk(s, 81);
    expect(decision).toEqual({ outcome: 'paged', kind: 'risk', level: PAGE_LEVEL.high, actionId: null });
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(texts()[0]).toMatch(/HIGH crisis flag\nWhy: RISK SCORE 81\/100/);
    expect(db.rows).toHaveLength(0);
  });

  it('pageHighRisk: keeps the escalate-tool wording, and a failed direct send is reported as not delivered', async () => {
    const s = session('s1', 7);
    breakDispatch();
    sendCrisisAlertMock.mockRejectedValueOnce(new Error('bridge down'));
    const decision = await pageHighRisk(s, 80, { source: 'model_escalation' });
    expect(decision).toMatchObject({ outcome: 'not_delivered', actionId: null });
    expect(texts()[0]).toMatch(/set by the ASSISTANT/);
  });

  it('pageVendorTermination (content filter): sends a vendor-cut page that does not claim to know the risk', async () => {
    const s = session('s1', 7);
    flag(s, 'high', 80);
    breakDispatch();
    const decision = await cut(s, { flagged: true, severity: 'high' });
    expect(decision).toEqual({
      outcome: 'paged',
      kind: 'vendor_cut',
      level: PAGE_LEVEL.mediumVendorCut,
      actionId: null,
    });
    expect(texts()[0]).toMatch(/Why: VENDOR CUT\. The risk level for this session could NOT be read/);
  });

  it('pageVendorTermination (session ceiling): sends the ceiling page', async () => {
    const s = session('s1', 7);
    breakDispatch();
    const decision = await pageVendorTermination({ sessionId: s, cause: 'expired', flagged: true, severity: 'high' });
    expect(decision).toMatchObject({ outcome: 'paged', kind: 'vendor_ceiling', actionId: null });
    expect(texts()[0]).toMatch(/Why: VENDOR SESSION LIMIT/);
  });
});
