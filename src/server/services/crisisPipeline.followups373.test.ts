// ai-therapist-373: the crisis pipeline's follow-ups from the PR #86 review.
//   1. Where a turn's history comes from (chooseHistory) and the check-in
//      kept at session start.
//   2. "Already paged" records expire with the fold window.
//   3. One turn, one flag: a re-scored turn and a flag retry.
// The scorer, the paging layer's send and the database are fakes; the clock is
// fake wherever time matters.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  analyzeMessageRisk: vi.fn(),
  flagSessionCrisis: vi.fn(),
  logInterventionAction: vi.fn(),
  executeGraduatedResponse: vi.fn(),
  pageHighRisk: vi.fn(),
  retryCrisisRecord: vi.fn(),
  getSessionCrisisState: vi.fn(),
  getRecentSessionMessages: vi.fn(),
  getSessionCheckin: vi.fn(),
}));

vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: m.analyzeMessageRisk,
  flagSessionCrisis: m.flagSessionCrisis,
  logInterventionAction: m.logInterventionAction,
}));
vi.mock('./crisisIntervention.service.js', () => ({
  maybeSteerSession: vi.fn(async () => undefined),
  shouldSteer: vi.fn(() => false),
  buildChatSteeringGuidance: vi.fn(() => 'STEER'),
  maybeRequireRiskCheck: vi.fn(async () => null),
  executeGraduatedResponse: m.executeGraduatedResponse,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
  subjectGuidance: () => null,
  subjectLabel: () => null,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: m.getRecentSessionMessages,
  getSessionCrisisState: m.getSessionCrisisState,
  getSessionHighFlagSubjects: vi.fn(async () => []),
  getSessionFlagEscalations: vi.fn(async () => []),
  isDemoAccountSession: vi.fn(async () => false),
  getSessionAccessInfo: vi.fn(async () => null),
  getSessionCheckin: m.getSessionCheckin,
  recordRecoveryDisclosure: vi.fn(async () => ({ recorded: false, eventId: null, stampedScore: null })),
  incidentHasCrisisAdverseEvent: vi.fn(async () => false),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: m.pageHighRisk,
  retryCrisisRecord: m.retryCrisisRecord,
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => 1) }));

const pipeline = await import('./crisisPipeline.service.js');
const {
  runCrisisPipeline,
  runCheckinCrisisScreen,
  chooseHistory,
  _resetEarlyPageStateForTests,
  FLAGGED_TURN_MEMORY_MS,
} = pipeline;
const { PAGE_FOLD_WINDOW_MS } = await import('./crisisPaging.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
const { rememberSessionAccount, _forgetSessionAccountsForTests } = await import('../utils/sessionAccounts.js');
const { rememberSessionStart, rememberTurn, _resetRecentTurnsForTests, forgetTurnsBefore, forgetParticipantTurns } =
  await import('../utils/recentTurns.js');

const acquireTimeout = () => new Error('timeout exceeded when trying to connect');
const UNFLAGGED = { crisis_flagged: false, crisis_severity: null, crisis_risk_score: null };

function highVerdict(extra: Record<string, unknown> = {}) {
  return { riskScore: 80, severity: 'high', factors: ['intent'], breakdown: {}, ...extra };
}

/** The scorer: reports the verdict as soon as it is known, like the real one. */
function scoreAs(verdict: Record<string, unknown>): void {
  m.analyzeMessageRisk.mockImplementation(
    async (_msg: unknown, _history: unknown, hooks?: { onScored?: (r: unknown) => void }) => {
      hooks?.onScored?.(verdict);
      return verdict;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
  _resetEarlyPageStateForTests();
  _resetRecentTurnsForTests();
  _forgetSessionAccountsForTests();
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = undefined;
  m.getRecentSessionMessages.mockResolvedValue([]);
  m.getSessionCheckin.mockResolvedValue(null);
  m.getSessionCrisisState.mockResolvedValue(UNFLAGGED);
  m.flagSessionCrisis.mockResolvedValue('written');
  m.logInterventionAction.mockResolvedValue(undefined);
  m.executeGraduatedResponse.mockResolvedValue(undefined);
  m.pageHighRisk.mockResolvedValue({ outcome: 'paged' });
  scoreAs({ riskScore: 0, severity: 'none', factors: [], breakdown: {} });
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(10_000);
  await _settleBackgroundForTests();
  vi.useRealTimers();
});

/** What the scorer was given for the last turn. */
function scoredWith(): { message: Record<string, unknown>; history: Array<Record<string, unknown>> } {
  const call = m.analyzeMessageRisk.mock.calls.at(-1) as [Record<string, unknown>, Array<Record<string, unknown>>];
  return { message: call[0], history: call[1] };
}

describe('chooseHistory: where a turn is read against', () => {
  const STORED = [{ role: 'user', content: 'stored', content_redacted: null, message_id: 1 }];

  it('the database answered and the turn was stored: the stored history, even when memory holds more', () => {
    rememberSessionStart('s1');
    rememberTurn('s1', 'user', 'kept');
    expect(chooseHistory({ sessionId: 's1', messageId: 1, content: 'x' }, STORED)).toEqual({
      rows: STORED,
      source: 'database',
    });
  });

  it('the read failed: memory, complete when this process saw the session start', () => {
    rememberSessionStart('s1');
    rememberTurn('s1', 'assistant', 'Are you safe?');
    const chosen = chooseHistory({ sessionId: 's1', messageId: 1, content: 'x' }, null);
    expect(chosen.source).toBe('memory');
    expect(chosen.rows.map((r) => r.content)).toEqual(['Are you safe?']);
  });

  it('the read failed and this process did not see the session start: memory, marked partial', () => {
    rememberTurn('s1', 'assistant', 'Are you safe?');
    expect(chooseHistory({ sessionId: 's1', messageId: 1, content: 'x' }, null).source).toBe('memory_partial');
  });

  it('the turn itself was not stored (no id): memory, even though the read answered', () => {
    rememberSessionStart('s1');
    rememberTurn('s1', 'user', 'kept');
    const chosen = chooseHistory({ sessionId: 's1', messageId: null, content: 'kept' }, STORED);
    expect(chosen.source).toBe('memory');
    expect(chosen.rows.map((r) => r.content)).toEqual(['kept']);
  });

  // PR #88 review: a copy known to be partial never displaces a history the
  // database did give (and so never puts the turn under the context-blind rule).
  it('the turn was not stored, the read answered, and memory is partial: the stored history', () => {
    rememberTurn('s1', 'user', 'kept');
    expect(chooseHistory({ sessionId: 's1', messageId: null, content: 'kept' }, STORED)).toEqual({
      rows: STORED,
      source: 'database',
    });
  });

  it('no id and nothing in memory: the stored history it did get', () => {
    expect(chooseHistory({ sessionId: 's1', messageId: null, content: 'x' }, STORED)).toEqual({
      rows: STORED,
      source: 'database',
    });
  });

  it('the read failed and memory holds nothing: none (the context-blind rule applies)', () => {
    expect(chooseHistory({ sessionId: 's1', messageId: 1, content: 'x' }, null)).toEqual({ rows: [], source: 'none' });
  });

  it('a session started here with no turn yet is not blind: memory, empty', () => {
    rememberSessionStart('s1');
    expect(chooseHistory({ sessionId: 's1', messageId: 1, content: 'x' }, null)).toEqual({
      rows: [],
      source: 'memory',
    });
  });

  it('memory rows carry the stored id when known, and never more than the assessor window', () => {
    rememberSessionStart('s1');
    for (let i = 1; i <= 12; i++) rememberTurn('s1', 'user', `t${i}`, { messageId: i === 12 ? 99 : null });
    const rows = chooseHistory({ sessionId: 's1', messageId: null, content: 't12' }, null).rows;
    expect(rows).toHaveLength(10);
    expect(rows.at(-1)?.message_id).toBe(99);
    expect(String(rows[0].message_id)).toMatch(/^mem:/);
  });

  // PR #91 review: a content wipe drops remembered turns of a session that is
  // still open, whose stored text the wipe kept (it is redacted only at end).
  // The copy is then short of the record, so it is partial: the stored history
  // is preferred when read, and the context-blind rule applies when it is not.
  it('a content wipe took turns from an open session: memory is partial', () => {
    const now = Date.now();
    rememberSessionStart('s1');
    rememberTurn('s1', 'user', 'I keep thinking about the pills', { at: now - 3 * 3_600_000 });
    rememberTurn('s1', 'assistant', 'Are you safe?', { at: now - 60_000 });
    forgetTurnsBefore(now - 3_600_000);
    expect(chooseHistory({ sessionId: 's1', messageId: 1, content: 'x' }, null).source).toBe('memory_partial');
    expect(chooseHistory({ sessionId: 's1', messageId: null, content: 'x' }, STORED)).toEqual({
      rows: STORED,
      source: 'database',
    });
  });

  // A withdrawn participant's live call: the copy is dropped, later turns
  // start a fragment, and a failed read puts the turn under the context-blind
  // rule rather than scoring it as complete.
  it('a withdrawal dropped the copy mid-call: later turns are partial', () => {
    rememberSessionStart('s1', null, 7);
    rememberTurn('s1', 'assistant', 'Are you safe?');
    forgetParticipantTurns(7);
    rememberTurn('s1', 'user', 'no');
    expect(chooseHistory({ sessionId: 's1', messageId: 1, content: 'no' }, null).source).toBe('memory_partial');
  });
});

describe('the pipeline reads memory when the database cannot answer', () => {
  it('a failed history read: the scorer gets the turns kept in memory, and is told where they came from', async () => {
    rememberSessionAccount('chat_m', 'participant');
    rememberSessionStart('chat_m');
    rememberTurn('chat_m', 'assistant', 'Are you thinking about suicide?');
    rememberTurn('chat_m', 'user', 'yes');
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'chat_m', messageId: 5, content: 'yes' }, 'chat');
    const { message, history } = scoredWith();
    expect(history.map((h) => h.content)).toEqual(['Are you thinking about suicide?', 'yes']);
    expect(message['history_source']).toBe('memory');
  });

  it('a history read past its 2 s bound is treated the same way', async () => {
    rememberSessionAccount('chat_m', 'participant');
    rememberTurn('chat_m', 'assistant', 'Are you safe?');
    m.getRecentSessionMessages.mockImplementation(() => new Promise(() => undefined));
    const done = runCrisisPipeline({ sessionId: 'chat_m', messageId: 5, content: 'no' }, 'chat');
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(scoredWith().history.map((h) => h.content)).toEqual(['Are you safe?']);
    expect(scoredWith().message['history_source']).toBe('memory_partial');
  });

  it('the stored history answered: the scorer is not told anything new (normal scoring unchanged)', async () => {
    rememberSessionAccount('chat_m', 'participant');
    rememberTurn('chat_m', 'user', 'kept');
    m.getRecentSessionMessages.mockResolvedValue([{ role: 'user', content: 'stored', message_id: 5 }]);
    await runCrisisPipeline({ sessionId: 'chat_m', messageId: 5, content: 'stored' }, 'chat');
    expect(scoredWith().history.map((h) => h.content)).toEqual(['stored']);
    expect('history_source' in scoredWith().message).toBe(false);
  });

  it('nothing from either source: the scorer is told so (none)', async () => {
    rememberSessionAccount('chat_m', 'participant');
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'chat_m', messageId: 5, content: 'yes' }, 'chat');
    expect(scoredWith().message['history_source']).toBe('none');
  });

  it('the check-in screen has no history and is not told it is blind', async () => {
    rememberSessionAccount('chat_c', 'participant');
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCheckinCrisisScreen('chat_c', { topic: 'tired' }, 'chat');
    expect(scoredWith().history).toEqual([]);
    expect('history_source' in scoredWith().message).toBe(false);
    expect(m.getRecentSessionMessages).toHaveBeenCalled();
  });

  it('voice: a split sentence is joined from memory, and stand-in ids are not passed on as row ids', async () => {
    rememberSessionAccount('live_s', 'participant');
    rememberSessionStart('live_s');
    rememberTurn('live_s', 'user', 'I keep thinking I should kill', { messageId: 41 });
    vi.advanceTimersByTime(800);
    rememberTurn('live_s', 'user', ' myself');
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'live_s', messageId: null, content: ' myself' }, 'realtime');
    expect(scoredWith().message['content']).toBe('I keep thinking I should kill myself');
    expect(scoredWith().message['stitched_message_ids']).toEqual([41]);
  });

  it('voice: an earlier part kept without a stored id is joined, and no id is passed for it', async () => {
    rememberSessionAccount('live_s', 'participant');
    rememberSessionStart('live_s');
    rememberTurn('live_s', 'user', 'I keep thinking I should kill');
    vi.advanceTimersByTime(800);
    rememberTurn('live_s', 'user', ' myself');
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'live_s', messageId: null, content: ' myself' }, 'realtime');
    expect(scoredWith().message['content']).toBe('I keep thinking I should kill myself');
    expect('stitched_message_ids' in scoredWith().message).toBe(false);
  });

  it('voice: parts further apart than the split window are not joined from memory either', async () => {
    rememberSessionAccount('live_s', 'participant');
    rememberSessionStart('live_s');
    rememberTurn('live_s', 'user', 'I keep thinking I should kill');
    vi.advanceTimersByTime(pipeline.SPLIT_TURN_WINDOW_MS + 1);
    rememberTurn('live_s', 'user', ' time with a puzzle');
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'live_s', messageId: null, content: ' time with a puzzle' }, 'realtime');
    expect(scoredWith().message['content']).toBe(' time with a puzzle');
  });

  it('voice, the turn stored but the history read failed: the turn is found in memory by its stored id', async () => {
    rememberSessionAccount('live_s', 'participant');
    rememberSessionStart('live_s');
    rememberTurn('live_s', 'user', 'how I would kill', { messageId: 40 });
    vi.advanceTimersByTime(500);
    rememberTurn('live_s', 'user', ' myself', { messageId: 41 });
    vi.advanceTimersByTime(500);
    // The same words again later, as a turn of its own: not the one scored.
    rememberTurn('live_s', 'user', ' myself', { messageId: 42 });
    m.getRecentSessionMessages.mockRejectedValue(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'live_s', messageId: 41, content: ' myself' }, 'realtime');
    expect(scoredWith().message['content']).toBe('how I would kill myself');
  });
});

describe('the check-in kept at session start', () => {
  it('the stored check-in cannot be read: the kept copy is put in front of the history', async () => {
    rememberSessionAccount('chat_k', 'participant');
    rememberSessionStart('chat_k', { topic: "I don't really want to be alive" });
    m.getSessionCheckin.mockRejectedValue(acquireTimeout());
    m.getRecentSessionMessages.mockResolvedValue([{ role: 'user', content: 'hi', message_id: 5 }]);
    await runCrisisPipeline({ sessionId: 'chat_k', messageId: 5, content: 'hi' }, 'chat');
    expect(scoredWith().history[0]).toEqual({
      role: 'user',
      content: "[Written in the pre-session check-in form] I don't really want to be alive",
    });
  });

  it('the check-in was never stored (its write is best effort): the kept copy is used', async () => {
    rememberSessionAccount('chat_k', 'participant');
    rememberSessionStart('chat_k', { topic: 'everything is too much' });
    m.getSessionCheckin.mockResolvedValue(null);
    await runCrisisPipeline({ sessionId: 'chat_k', messageId: 5, content: 'hi' }, 'chat');
    expect(scoredWith().history[0]?.content).toBe('[Written in the pre-session check-in form] everything is too much');
  });

  it('the stored check-in wins when it can be read', async () => {
    rememberSessionAccount('chat_k', 'participant');
    rememberSessionStart('chat_k', { topic: 'kept copy' });
    m.getSessionCheckin.mockResolvedValue({ topic: 'stored copy', goal: null });
    await runCrisisPipeline({ sessionId: 'chat_k', messageId: 5, content: 'hi' }, 'chat');
    expect(scoredWith().history[0]?.content).toBe('[Written in the pre-session check-in form] stored copy');
  });
});

describe('"already paged" records expire with the fold window', () => {
  const critical = () => highVerdict({ riskScore: 95, sessionFlaggedHigh: true });

  it('a critical turn inside the window is not paged again early; one after it is', async () => {
    rememberSessionAccount('live_p', 'participant');
    scoreAs(critical());
    await runCrisisPipeline({ sessionId: 'live_p', messageId: 1, content: 'a' }, 'realtime');
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PAGE_FOLD_WINDOW_MS - 1_000);
    await runCrisisPipeline({ sessionId: 'live_p', messageId: 2, content: 'b' }, 'realtime');
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await runCrisisPipeline({ sessionId: 'live_p', messageId: 3, content: 'c' }, 'realtime');
    expect(m.pageHighRisk).toHaveBeenCalledTimes(2);
    expect(m.pageHighRisk.mock.calls[1][2]).toMatchObject({ requested: 'on_score' });
  });

  it('an hour later, a new critical turn gets the early page', async () => {
    rememberSessionAccount('live_p', 'participant');
    scoreAs(critical());
    await runCrisisPipeline({ sessionId: 'live_p', messageId: 1, content: 'a' }, 'realtime');
    vi.advanceTimersByTime(60 * 60 * 1000);
    await runCrisisPipeline({ sessionId: 'live_p', messageId: 2, content: 'b' }, 'realtime');
    expect(m.pageHighRisk).toHaveBeenCalledTimes(2);
  });
});

describe('one turn, one flag', () => {
  it('the same turn scored again with its stored id (a re-sent batch) is not flagged again', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(1);
    // Staff unflag; the batch is re-sent and stored; the same turn is scored.
    m.getSessionCrisisState.mockResolvedValue(UNFLAGGED);
    vi.advanceTimersByTime(60_000);
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 88, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(1);
    expect(m.executeGraduatedResponse).toHaveBeenCalledTimes(1);
  });

  it('two stored turns with the same words are two turns', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 1, content: 'I want to die' }, 'realtime');
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 2, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });

  it('the same words in another session are another turn', async () => {
    rememberSessionAccount('live_d', 'participant');
    rememberSessionAccount('live_e', 'participant');
    scoreAs(highVerdict());
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    await runCrisisPipeline({ sessionId: 'live_e', messageId: null, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });

  it('after the memory window the same words flag again', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    vi.advanceTimersByTime(FLAGGED_TURN_MEMORY_MS + 1);
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 9, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });

  it('a flag write that failed is not "on record": the re-scored turn flags', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    m.flagSessionCrisis.mockRejectedValueOnce(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 88, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });

  it('the retry of a failed flag writes nothing once the re-scored turn has flagged', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    m.flagSessionCrisis.mockRejectedValueOnce(acquireTimeout());
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    const retry = m.retryCrisisRecord.mock.calls[0][0] as { write: () => Promise<unknown> };
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 88, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
    await expect(retry.write()).resolves.toBe('skipped_duplicate');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });

  it('the retry carries the first attempt time, and a retry that writes marks the turn on record', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    m.flagSessionCrisis.mockRejectedValueOnce(acquireTimeout());
    const attemptAt = Date.now();
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    const retry = m.retryCrisisRecord.mock.calls[0][0] as { write: () => Promise<unknown> };
    vi.advanceTimersByTime(30_000);
    await expect(retry.write()).resolves.toBe('written');
    const options = m.flagSessionCrisis.mock.calls[1][8] as { retry: boolean; attemptedAt: Date };
    expect(options.retry).toBe(true);
    expect(options.attemptedAt.getTime()).toBe(attemptAt);
    // The batch is re-sent afterwards: the turn is already on record.
    await runCrisisPipeline({ sessionId: 'live_d', messageId: 88, content: 'I want to die' }, 'realtime');
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });

  it('a retry the database skipped (staff unflagged) does not mark the turn on record', async () => {
    rememberSessionAccount('live_d', 'participant');
    scoreAs(highVerdict());
    m.flagSessionCrisis.mockRejectedValueOnce(acquireTimeout()).mockResolvedValueOnce('skipped_unflagged');
    await runCrisisPipeline({ sessionId: 'live_d', messageId: null, content: 'I want to die' }, 'realtime');
    const retry = m.retryCrisisRecord.mock.calls[0][0] as { write: () => Promise<unknown> };
    await expect(retry.write()).resolves.toBe('skipped_unflagged');
    expect(pipeline.flaggedTurnOnRecord({ sessionId: 'live_d', messageId: null, content: 'I want to die' })).toBe(
      false,
    );
  });
});
