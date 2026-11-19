// One "Yes" must page the on-call once (PR #77 review, ai-therapist-356 item 5).
//
// On the first turn after a crisis text hand-off the participant taps "Yes"
// (to "Are you thinking about ending your life tonight?"). Two things then ask
// for a page about 3 seconds apart, both through crisisPaging.pageHighRisk:
//   1. the crisis pipeline: the chat session's only high flag is the hand-off's
//      continuation stamp, so the high-scoring "Yes" pages through
//      handleHighTurnWithoutReflag (facts.trigger 'high_turn_in_recovery_session');
//   2. the model's escalate_to_human at high urgency, through
//      executeGraduatedResponse (facts.source 'model_escalation', fixed score 80).
//
// This replays that sequence against the REAL paging policy (crisisPaging
// service unmocked) with the pager mocked as delivering, and counts the texts.
// The database layer is an in-memory copy of the three paging queries the
// path uses; the same replay against the real SQL is
// crisisPaging.handoffYes.live.test.ts. Nothing here can text anyone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface Row {
  action_id: number;
  session_id: string;
  action_type: string;
  action_details: Record<string, unknown>;
  performed_at: Date;
}

const { db, pager } = vi.hoisted(() => ({
  db: { owners: new Map<string, number | null>(), rows: [] as Row[], nextId: 1 },
  pager: { calls: [] as string[], delayMs: 0 },
}));

vi.mock('../db/paging.queries.js', () => ({
  INCIDENT_CHAIN_BACKSTOP_MS: 12 * 60 * 60 * 1000,
  getPagingParticipantUserId: vi.fn(async (sessionId: string) => db.owners.get(sessionId) ?? null),
  // The WHERE clause of the real query: this session, or any session of the
  // same participant, since `since`.
  getRecentPagingRecords: vi.fn(async (sessionId: string, userId: number | null, since: Date) =>
    db.rows
      .filter(
        (r) =>
          r.performed_at.getTime() >= since.getTime() &&
          'paging' in r.action_details &&
          (r.session_id === sessionId || (userId !== null && db.owners.get(r.session_id) === userId)),
      )
      .sort((a, b) => b.performed_at.getTime() - a.performed_at.getTime()),
  ),
  insertPagingRecord: vi.fn(async (sessionId: string, actionType: string, details: Record<string, unknown>) => {
    const row: Row = {
      action_id: db.nextId++,
      session_id: sessionId,
      action_type: actionType,
      action_details: JSON.parse(JSON.stringify(details)) as Record<string, unknown>,
      performed_at: new Date(),
    };
    db.rows.push(row);
    return row.action_id;
  }),
  // Not on the pageHighRisk path.
  getIncidentChainSessionIds: vi.fn(async (id: string) => [id]),
  // The voice call's disclosure, for the vendor-cut page.
  getParticipantFlagEvents: vi.fn(async (ids: string[]) =>
    ids.includes('live_cut_voice') ? [{ session_id: 'live_cut_voice', severity: 'high', risk_score: 85 }] : [],
  ),
  getParticipantAssessedRisk: vi.fn(async () => []),
  participantSpokeSince: vi.fn(async () => true),
  getUnfinishedSilenceChecks: vi.fn(async () => []),
  claimSilenceCheck: vi.fn(async () => null),
  releaseSilenceCheck: vi.fn(async () => false),
  finishSilenceCheck: vi.fn(async () => false),
}));
// The pager: every send is DELIVERED (after `delayMs`), and counted.
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock(async (message: string) => {
    pager.calls.push(message);
    if (pager.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, pager.delayMs));
    return true;
  }),
);
vi.mock('./suppression.js', () => ({ sessionSuppressesCrisisPaging: vi.fn(async () => false) }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn(async () => undefined) }));

import { pageHighRisk, pageVendorTermination, _resetPagingStateForTests } from './crisisPaging.service.js';

const PARTICIPANT = 41;
const VOICE = 'live_cut_voice';
const CHAT = 'chat_handoff';

/** The two requests, exactly as their callers make them. */
const pipelinePage = (score: number) => pageHighRisk(CHAT, score, { trigger: 'high_turn_in_recovery_session' }); // crisisPipeline handleHighTurnWithoutReflag
const escalationPage = () => pageHighRisk(CHAT, 80, { source: 'model_escalation' }); // toolRegistry escalate_to_human, urgency high

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-19T21:40:00-07:00'));
  db.owners.clear();
  db.rows.length = 0;
  db.nextId = 1;
  pager.calls.length = 0;
  pager.delayMs = 0;
  _resetPagingStateForTests();
  db.owners.set(VOICE, PARTICIPANT);
  db.owners.set(CHAT, PARTICIPANT);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fire the pipeline's request, then the escalation `gapMs` later, and wait for both. */
async function replay(yesScore: number, gapMs = 3_000) {
  const first = pipelinePage(yesScore);
  await vi.advanceTimersByTimeAsync(gapMs);
  const second = escalationPage();
  await vi.advanceTimersByTimeAsync(10_000);
  return Promise.all([first, second]);
}

describe('one "Yes" on the fast first turn after a crisis hand-off pages the on-call once', () => {
  it.each([
    ['a high "Yes" (85)', 85],
    ['a critical "Yes" (94)', 94],
    ['a "Yes" at the bottom of the high band (75)', 75],
  ])('%s, then the model escalates 3 s later: one text', async (_name, score) => {
    const [first, second] = await replay(score);
    expect(pager.calls).toHaveLength(1);
    expect(first.outcome).toBe('paged');
    expect(second.outcome).toBe('folded');
    expect(second.foldedIntoActionId).toBe(first.actionId);
    // The fold is on record, pointing at the page that covered it.
    const folded = db.rows.find((r) => r.action_id === second.actionId)!;
    expect(folded.action_type).toBe('external_api_called');
    expect(folded.action_details).toMatchObject({ reason: 'folded_into_recent_page' });
  });

  it('the escalation arrives while the first page is still being sent: it waits for it and folds (one text)', async () => {
    pager.delayMs = 4_500; // longer than the 3 s gap
    const [first, second] = await replay(85);
    expect(pager.calls).toHaveLength(1);
    expect(first.outcome).toBe('paged');
    expect(second.outcome).toBe('folded');
  });

  it('the other order (escalation first, the pipeline 3 s later) is also one text', async () => {
    const first = escalationPage();
    await vi.advanceTimersByTimeAsync(3_000);
    const second = pipelinePage(85);
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await Promise.all([first, second]);
    expect(pager.calls).toHaveLength(1);
    expect(results.map((r) => r.outcome)).toEqual(['paged', 'folded']);
  });

  it('after a delivered vendor-cut page for the same incident, the "Yes" and the escalation add nothing', async () => {
    // The cut itself paged (high risk in the voice call).
    const cut = await pageVendorTermination({
      sessionId: VOICE,
      cause: 'content_filter',
      flagged: true,
      severity: 'high',
    });
    expect(cut.outcome).toBe('paged');
    expect(pager.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    const [first, second] = await replay(85);
    expect(pager.calls).toHaveLength(1);
    expect([first.outcome, second.outcome]).toEqual(['folded', 'folded']);
  });

  it('a critical "Yes" after a high vendor-cut page is new information: exactly one more text, not two', async () => {
    await pageVendorTermination({ sessionId: VOICE, cause: 'content_filter', flagged: true, severity: 'high' });
    await vi.advanceTimersByTimeAsync(20_000);
    const [first, second] = await replay(94);
    expect(pager.calls).toHaveLength(2);
    expect(first.outcome).toBe('paged');
    expect(second.outcome).toBe('folded');
  });
});
