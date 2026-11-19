import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Mock every collaborator so the shared pipeline runs without a DB or network.
// The pipeline's job is orchestration: demo skip, steering delivery per
// channel, and the graduated-flag decision matrix.
const {
  analyzeMessageRiskMock,
  flagSessionCrisisMock,
  logInterventionActionMock,
  maybeSteerSessionMock,
  shouldSteerMock,
  buildChatSteeringGuidanceMock,
  maybeRequireRiskCheckMock,
  executeGraduatedResponseMock,
  getRecentSessionMessagesMock,
  getSessionCrisisStateMock,
  isDemoAccountSessionMock,
  getSessionAccessInfoMock,
  enqueueWorkItemMock,
  pageHighRiskMock,
  retryCrisisRecordMock,
  recordRecoveryDisclosureMock,
  incidentHasCrisisAdverseEventMock,
  draftAdverseEventFromCrisisMock,
} = vi.hoisted(() => ({
  pageHighRiskMock: vi.fn(async () => ({ outcome: 'paged' })),
  retryCrisisRecordMock: vi.fn(),
  recordRecoveryDisclosureMock: vi.fn(),
  incidentHasCrisisAdverseEventMock: vi.fn(),
  draftAdverseEventFromCrisisMock: vi.fn(async () => 1),
  analyzeMessageRiskMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  maybeSteerSessionMock: vi.fn(),
  shouldSteerMock: vi.fn(),
  buildChatSteeringGuidanceMock: vi.fn(),
  maybeRequireRiskCheckMock: vi.fn(),
  executeGraduatedResponseMock: vi.fn(),
  getRecentSessionMessagesMock: vi.fn(),
  getSessionCrisisStateMock: vi.fn(),
  isDemoAccountSessionMock: vi.fn(),
  getSessionAccessInfoMock: vi.fn(),
  enqueueWorkItemMock: vi.fn(),
}));

vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: analyzeMessageRiskMock,
  flagSessionCrisis: flagSessionCrisisMock,
  logInterventionAction: logInterventionActionMock,
}));
vi.mock('./crisisIntervention.service.js', () => ({
  maybeSteerSession: maybeSteerSessionMock,
  shouldSteer: shouldSteerMock,
  buildChatSteeringGuidance: buildChatSteeringGuidanceMock,
  maybeRequireRiskCheck: maybeRequireRiskCheckMock,
  executeGraduatedResponse: executeGraduatedResponseMock,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
  subjectGuidance: () => null,
  subjectLabel: () => null,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: getRecentSessionMessagesMock,
  getSessionCrisisState: getSessionCrisisStateMock,
  // No automatic high flag on record about anyone: the level rule decides.
  getSessionHighFlagSubjects: vi.fn(async () => []),
  isDemoAccountSession: isDemoAccountSessionMock,
  getSessionAccessInfo: getSessionAccessInfoMock,
  // No pre-session check-in in these tests (see crisisPipeline.thirdPartyCheckin.test.ts).
  getSessionCheckin: vi.fn(async () => null),
  recordRecoveryDisclosure: recordRecoveryDisclosureMock,
  incidentHasCrisisAdverseEvent: incidentHasCrisisAdverseEventMock,
  // Transitive imports of utils/adminBroadcast.js:
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: enqueueWorkItemMock }));
// The real level rule and constants (riskPageLevel, PAGE_LEVEL,
// REPAGE_ON_STATED_TIME_OR_PLAN); only the page itself is a mock.
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: pageHighRiskMock,
  retryCrisisRecord: retryCrisisRecordMock,
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: draftAdverseEventFromCrisisMock }));

const {
  runCrisisPipeline,
  handleHighTurnWithoutReflag,
  RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS,
  _resetEarlyPageStateForTests,
} = await import('./crisisPipeline.service.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');

const emitMock = vi.fn();
const toMock = vi.fn(() => ({ emit: emitMock }));

beforeEach(() => {
  vi.clearAllMocks();
  _resetEarlyPageStateForTests();
  (global as unknown as { io: unknown }).io = { to: toMock };
  isDemoAccountSessionMock.mockResolvedValue(false);
  getRecentSessionMessagesMock.mockResolvedValue([]);
  getSessionCrisisStateMock.mockResolvedValue({
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: null,
  });
  getSessionAccessInfoMock.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'voice' });
  enqueueWorkItemMock.mockResolvedValue(null);
  buildChatSteeringGuidanceMock.mockImplementation((s: number) => `CHAT_STEER_${s}`);
  shouldSteerMock.mockReturnValue(true);
  maybeRequireRiskCheckMock.mockResolvedValue(null);
  // Default: an ordinary session whose high flag came from the participant.
  recordRecoveryDisclosureMock.mockResolvedValue({ recorded: false, eventId: null, stampedScore: null });
  incidentHasCrisisAdverseEventMock.mockResolvedValue(false);
});

// runCrisisPipeline hands a high turn in an already-high session to
// handleHighTurnWithoutReflag without waiting for it, and that work pages
// through a dynamic import. Let it finish inside the test that started it, or
// its page lands in the next test's mocks (the stage-deploy failure of
// 627133d: cold transform cache, the import took longer than a 10 ms sleep).
afterEach(async () => {
  await _settleBackgroundForTests();
});

const TURN = { sessionId: 'chat_1', messageId: 42, content: 'hi' };

function risk(riskScore: number, severity: string, factors: string[] = []) {
  analyzeMessageRiskMock.mockResolvedValue({ riskScore, severity, factors, breakdown: {} });
}

describe('runCrisisPipeline — demo + none', () => {
  it('demo sessions skip everything and return NONE', async () => {
    isDemoAccountSessionMock.mockResolvedValue(true);
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r).toEqual({ riskScore: 0, severity: 'none', factors: [], flagged: false, steeringGuidance: null });
    expect(analyzeMessageRiskMock).not.toHaveBeenCalled();
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });

  it('score 0 → no steering, no flag', async () => {
    risk(0, 'none');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.flagged).toBe(false);
    expect(r.steeringGuidance).toBeNull();
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(maybeSteerSessionMock).not.toHaveBeenCalled();
  });
});

describe('runCrisisPipeline — flag matrix', () => {
  it('low severity (score>0) does not flag', async () => {
    risk(30, 'low');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });

  it('medium flags', async () => {
    risk(55, 'medium');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
    expect(flagSessionCrisisMock).toHaveBeenCalledOnce();
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'auto_flag', expect.any(Object));
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'medium', 55);
    expect(toMock).toHaveBeenCalledWith('admin-broadcast');
  });

  it('high flags + graduated response', async () => {
    risk(90, 'high');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90, { pageAlreadyRequested: true });
  });

  it('does NOT re-flag when already flagged at same severity without +10 escalation', async () => {
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: 'medium',
      crisis_risk_score: 55,
    });
    risk(58, 'medium'); // +3, below the +10 rule
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });

  it('re-flags on severity escalation medium→high', async () => {
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: 'medium',
      crisis_risk_score: 55,
    });
    risk(80, 'high');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
  });

  it('re-flags on same severity but +10 score jump', async () => {
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: 'medium',
      crisis_risk_score: 55,
    });
    risk(70, 'medium'); // +15 > +10
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
  });

  // A recovery session is stamped high at the inherited score, or at 100, so
  // the re-flag rule never fires in it. Every high turn the rule lets pass is
  // handed to handleHighTurnWithoutReflag (below), without holding the turn.
  // The scorer read the session as already flagged high and the turn is at the
  // ordinary high level, so it was not paged when it scored (ai-therapist-369):
  // the pipeline's own rules decide, exactly as before.
  it('a high turn in an already-high session that is not re-flagged is handed on, and the turn does not wait', async () => {
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: 'high',
      crisis_risk_score: 100,
    });
    analyzeMessageRiskMock.mockResolvedValue({
      riskScore: 85,
      severity: 'high',
      factors: ['explicit_intent'],
      breakdown: {},
      sessionFlaggedHigh: true,
    });
    // The record has not answered when the turn returns. Fake timers: the
    // 2-second cap on it must not fire on the wall clock, in whatever test is
    // running two seconds from now.
    vi.useFakeTimers();
    try {
      let land: (value: unknown) => void = () => undefined;
      recordRecoveryDisclosureMock.mockReturnValue(new Promise((resolve) => (land = resolve)));
      const r = await runCrisisPipeline(TURN, 'realtime');
      expect(r.flagged).toBe(false);
      expect(flagSessionCrisisMock).not.toHaveBeenCalled();
      expect(recordRecoveryDisclosureMock).toHaveBeenCalledWith({
        sessionId: 'chat_1',
        riskScore: 85,
        messageId: 42,
        factors: ['explicit_intent'],
      });
      expect(pageHighRiskMock).not.toHaveBeenCalled();
      // Past the cap the page goes without the record; then the record lands.
      await vi.advanceTimersByTimeAsync(RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS);
      land({ recorded: false, eventId: null, stampedScore: null });
      await _settleBackgroundForTests();
      expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
      expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 85, { trigger: 'high_turn_in_recovery_session' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not asked when the turn re-flags (that path flags and pages itself), nor for a turn below high', async () => {
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: 'high',
      crisis_risk_score: 75,
    });
    risk(95, 'high'); // +20: re-flag; paged when it scored (ai-therapist-369)
    await runCrisisPipeline(TURN, 'realtime');
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 95, { pageAlreadyRequested: true });
    risk(60, 'medium');
    await runCrisisPipeline(TURN, 'realtime');
    await _settleBackgroundForTests();
    expect(recordRecoveryDisclosureMock).not.toHaveBeenCalled();
    // The one page is the 95 turn's own, requested as it scored.
    expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 95, expect.objectContaining({ requested: 'on_score' }));
  });
});

// ai-therapist-363. Before: a real high disclosure in a recovery session (high
// flag = the automatic continuation stamp) paged, and left no flag event and,
// when the session it continues was never flagged, no adverse-event draft.
describe('a high turn the re-flag rule let pass (handleHighTurnWithoutReflag)', () => {
  const HIGH = { riskScore: 78, factors: ['explicit_intent', 'plan'] };
  const recordedAs = { recorded: true, eventId: 501, stampedScore: 100 };
  // handleHighTurnWithoutReflag's promise settles when its page, dashboard
  // events and draft have: awaiting it is all the waiting these tests need.
  // The paging module is mocked over its real exports (importOriginal), so
  // its first dynamic import loads the whole paging graph; loaded once up
  // front, the fake-timer tests below do not race that load.
  beforeAll(async () => {
    await import('./crisisPaging.service.js');
  });

  it('stamp-only recovery session: the disclosure is recorded, paged, logged, shown, queued and gets its adverse-event draft', async () => {
    recordRecoveryDisclosureMock.mockResolvedValue(recordedAs);
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');

    expect(recordRecoveryDisclosureMock).toHaveBeenCalledTimes(1);
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 78, { trigger: 'high_turn_in_recovery_session' });
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'auto_flag', {
      riskScore: 78,
      severity: 'high',
      messageId: 42,
      factors: ['explicit_intent', 'plan'],
      recoveryDisclosure: true,
      crisisEventId: 501,
      replacesStampScore: 100,
    });
    const events = emitMock.mock.calls.map((c) => c[0]);
    expect(events).toContain('session:crisis-detected');
    expect(incidentHasCrisisAdverseEventMock).toHaveBeenCalledWith('chat_1');
    expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledWith('chat_1');
    expect(enqueueWorkItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'crisis_flag', sourceId: 'chat_1:high', sessionId: 'chat_1', reopen: true }),
    );
    // The record path does not re-run the high-risk response or the flag writer.
    expect(executeGraduatedResponseMock).not.toHaveBeenCalled();
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });

  it('the incident already has its adverse-event report (flagged high before the cut): no second draft', async () => {
    recordRecoveryDisclosureMock.mockResolvedValue({ ...recordedAs, stampedScore: 82 });
    incidentHasCrisisAdverseEventMock.mockResolvedValue(true);
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
    expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'auto_flag', expect.any(Object));
    expect(draftAdverseEventFromCrisisMock).not.toHaveBeenCalled();
  });

  it('if it cannot tell whether the incident has a report, it drafts one', async () => {
    recordRecoveryDisclosureMock.mockResolvedValue(recordedAs);
    incidentHasCrisisAdverseEventMock.mockRejectedValue(new Error('db down'));
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
    expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledWith('chat_1');
  });

  // PR 65 with PR 70: the rule that a critical turn without a re-flag always
  // asks for a page lives here now, and holds when a REAL high flag exists.
  it('a real high flag and a turn at 90 or more: a page is requested (the fold rule decides), nothing is written', async () => {
    await handleHighTurnWithoutReflag(TURN, { riskScore: 95, factors: ['attempt'] }, 'realtime');
    expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 95, { trigger: 'critical_turn_without_reflag' });
    expect(logInterventionActionMock).not.toHaveBeenCalled();
    expect(draftAdverseEventFromCrisisMock).not.toHaveBeenCalled();
  });

  // PR #86 review: the pipeline already paged this turn when it scored
  // (respondToHighVerdict); the hand-on must not request it a second time.
  it('page already requested when it scored: a critical turn in a real high flag is not paged again', async () => {
    await handleHighTurnWithoutReflag(TURN, { riskScore: 95, factors: ['attempt'] }, 'realtime', {
      pageAlreadyRequested: true,
    });
    expect(pageHighRiskMock).not.toHaveBeenCalled();
  });

  it('page already requested when it scored: a recovery disclosure is recorded but not paged again', async () => {
    recordRecoveryDisclosureMock.mockResolvedValue(recordedAs);
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime', { pageAlreadyRequested: true });
    expect(pageHighRiskMock).not.toHaveBeenCalled();
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'auto_flag', expect.any(Object));
    expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledTimes(1);
  });

  it('a real high flag and an attempt in progress scored below 90: still requested, with what it says', async () => {
    await handleHighTurnWithoutReflag(TURN, { riskScore: 85, factors: [], acute: 'attempt' }, 'realtime');
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 85, {
      escalation: 'attempt',
      trigger: 'critical_turn_without_reflag',
    });
  });

  it('a real high flag and a stated time or plan below 90: requested (REPAGE_ON_STATED_TIME_OR_PLAN)', async () => {
    await handleHighTurnWithoutReflag(TURN, { riskScore: 85, factors: [], acute: 'plan_or_time' }, 'realtime');
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 85, {
      escalation: 'plan_or_time',
      trigger: 'stated_plan_without_reflag',
    });
  });

  it('who the turn is about goes into the page, the record, the dashboard, the work item and the draft', async () => {
    recordRecoveryDisclosureMock.mockResolvedValue(recordedAs);
    const THIRD = 'third party at risk (reported by participant)';
    await handleHighTurnWithoutReflag(
      TURN,
      { riskScore: 90, factors: [THIRD, 'stated intent'], subject: 'third_party', acute: 'plan_or_time' },
      'realtime',
    );

    // The crisis event carries the subject through its factors (the label first).
    expect(recordRecoveryDisclosureMock).toHaveBeenCalledWith(
      expect.objectContaining({ factors: [THIRD, 'stated intent'] }),
    );
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 90, {
      subject: 'third_party',
      escalation: 'plan_or_time',
      trigger: 'high_turn_in_recovery_session',
    });
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      'chat_1',
      'auto_flag',
      expect.objectContaining({ recoveryDisclosure: true, subject: 'third_party', escalation: 'plan_or_time' }),
    );
    expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledWith('chat_1', { subject: 'third_party' });
    expect(enqueueWorkItemMock.mock.calls[0][0].title).toContain('third party at risk');
  });

  it('a session with a real high flag: nothing is written, paged or drafted (no duplicates)', async () => {
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
    expect(recordRecoveryDisclosureMock).toHaveBeenCalledTimes(1);
    expect(pageHighRiskMock).not.toHaveBeenCalled();
    expect(logInterventionActionMock).not.toHaveBeenCalled();
    expect(draftAdverseEventFromCrisisMock).not.toHaveBeenCalled();
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('the second high turn of the same recovery session finds the real flag and adds nothing', async () => {
    recordRecoveryDisclosureMock
      .mockResolvedValueOnce(recordedAs)
      .mockResolvedValueOnce({ recorded: false, eventId: null, stampedScore: null });
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
    await handleHighTurnWithoutReflag({ ...TURN, messageId: 43 }, { riskScore: 80, factors: [] }, 'realtime');
    expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).toHaveBeenCalledTimes(1);
  });

  // Two high turns of one recovery session at once. The record is what makes
  // it one disclosure (recordRecoveryDisclosure locks the session row: the
  // second call finds the first one's event and returns recorded=false), so
  // only the first call logs, queues and drafts; the second turn, below the
  // critical level, asks for no page of its own.
  it('two high turns of the same recovery session at once: one record, one page, one draft', async () => {
    recordRecoveryDisclosureMock
      .mockResolvedValueOnce(recordedAs)
      .mockResolvedValueOnce({ recorded: false, eventId: null, stampedScore: null });
    await Promise.all([
      handleHighTurnWithoutReflag(TURN, HIGH, 'realtime'),
      handleHighTurnWithoutReflag({ ...TURN, messageId: 43 }, { riskScore: 80, factors: [] }, 'realtime'),
    ]);
    expect(recordRecoveryDisclosureMock).toHaveBeenCalledTimes(2);
    expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    expect(logInterventionActionMock).toHaveBeenCalledTimes(1);
    expect(incidentHasCrisisAdverseEventMock).toHaveBeenCalledTimes(1);
    expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledTimes(1);
    expect(enqueueWorkItemMock).toHaveBeenCalledTimes(1);
  });

  it('fails toward paging: the record throws, so the page goes anyway and nothing is claimed in the record', async () => {
    recordRecoveryDisclosureMock.mockRejectedValue(new Error('db down'));
    await handleHighTurnWithoutReflag(TURN, HIGH, 'chat');
    expect(pageHighRiskMock).toHaveBeenCalledWith('chat_1', 78, { trigger: 'high_turn_in_recovery_session' });
    expect(logInterventionActionMock).not.toHaveBeenCalled();
    expect(draftAdverseEventFromCrisisMock).not.toHaveBeenCalled();
  });

  it('a slow record does not hold the page back, and the record-side work still follows when it lands', async () => {
    vi.useFakeTimers();
    try {
      let land: (value: unknown) => void = () => undefined;
      recordRecoveryDisclosureMock.mockReturnValue(new Promise((resolve) => (land = resolve)));
      const handling = handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
      await vi.advanceTimersByTimeAsync(RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS - 50);
      expect(pageHighRiskMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      // Past the cap the page is requested through a dynamic import, which
      // fake time does not move: when this test is the first in the run to
      // import crisisPaging, the import is still loading here. Wait for the
      // page itself (the record has still not landed) instead of a tick count.
      await vi.waitFor(() => expect(pageHighRiskMock).toHaveBeenCalledTimes(1));
      expect(logInterventionActionMock).not.toHaveBeenCalled();

      land(recordedAs);
      await handling;
      expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'auto_flag', expect.any(Object));
      expect(draftAdverseEventFromCrisisMock).toHaveBeenCalledTimes(1);
      expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // PR #83 review (ai-therapist-369 item 7): the slow path pages first, then
  // waits for the record. When the record finally answers recorded: false (a
  // real high flag exists; nothing was claimed), nothing may be written.
  it('a slow record that finally answers "not recorded" writes nothing (the page stands)', async () => {
    vi.useFakeTimers();
    try {
      let land: (value: unknown) => void = () => undefined;
      recordRecoveryDisclosureMock.mockReturnValue(new Promise((resolve) => (land = resolve)));
      const handling = handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
      await vi.advanceTimersByTimeAsync(RECOVERY_DISCLOSURE_RECORD_TIMEOUT_MS + 50);
      await vi.waitFor(() => expect(pageHighRiskMock).toHaveBeenCalledTimes(1));

      land({ recorded: false, eventId: null, stampedScore: null });
      await handling;
      await _settleBackgroundForTests();
      expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
      expect(logInterventionActionMock).not.toHaveBeenCalled();
      expect(incidentHasCrisisAdverseEventMock).not.toHaveBeenCalled();
      expect(draftAdverseEventFromCrisisMock).not.toHaveBeenCalled();
      expect(enqueueWorkItemMock).not.toHaveBeenCalled();
      expect(getSessionAccessInfoMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an anonymous session gets the record and the page, and no care-team item', async () => {
    recordRecoveryDisclosureMock.mockResolvedValue(recordedAs);
    getSessionAccessInfoMock.mockResolvedValue({ status: 'active', user_id: null, session_type: 'voice' });
    await handleHighTurnWithoutReflag(TURN, HIGH, 'realtime');
    expect(pageHighRiskMock).toHaveBeenCalledTimes(1);
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
  });

  // The text hand-off stamps a chat high with NO score when the incident's
  // risk could not be read (textHandoff.service). Seen live in the PR #77
  // review: "Not sure" scored 65/medium and the +10 clause rewrote the session
  // to medium.
  it('never lowers the severity: a medium turn under a high flag stored without a score', async () => {
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: 'high',
      crisis_risk_score: null,
    });
    risk(65, 'medium');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    // A high turn under the same stamp still flags (and pages) for real.
    risk(80, 'high');
    const high = await runCrisisPipeline(TURN, 'chat');
    expect(high.flagged).toBe(true);
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 80, { pageAlreadyRequested: true });
  });
});

describe('runCrisisPipeline — steering delivery per channel', () => {
  it('realtime delegates to maybeSteerSession and returns null guidance', async () => {
    risk(40, 'medium');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 40, 'medium', false);
    expect(r.steeringGuidance).toBeNull();
  });

  it.each(['attempt', 'plan_or_time'] as const)(
    'realtime high turn stating %s: the steer is told, so it carries no voice heads-up',
    async (acute) => {
      analyzeMessageRiskMock.mockResolvedValue({ riskScore: 95, severity: 'high', factors: [], breakdown: {}, acute });
      await runCrisisPipeline(TURN, 'realtime');
      expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 95, 'high', true, null, null, acute);
    },
  );

  it('chat returns base steering guidance and logs risk_steering', async () => {
    risk(40, 'medium');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBe('CHAT_STEER_40');
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      'chat_1',
      'risk_steering',
      expect.objectContaining({ channel: 'chat' }),
    );
    expect(maybeSteerSessionMock).not.toHaveBeenCalled();
  });

  it('chat high severity uses the safety-protocol guidance and logs safety_protocol', async () => {
    risk(90, 'high');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBe('CHAT_HIGH_GUIDANCE');
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      'chat_1',
      'safety_protocol',
      expect.objectContaining({ channel: 'chat' }),
    );
  });

  it('chat honors the steering cooldown (shouldSteer false → no guidance)', async () => {
    shouldSteerMock.mockReturnValue(false);
    risk(40, 'medium');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBeNull();
  });
});

describe('runCrisisPipeline — crisis_flag work item', () => {
  it('enqueues a reopen-able pool item for a logged-in participant session', async () => {
    risk(90, 'high', ['suicidal_ideation']);
    const turn = { ...TURN, content: 'a distinctive participant utterance' };
    await runCrisisPipeline(turn, 'realtime');
    expect(enqueueWorkItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: 'crisis_flag',
        severity: 'urgent',
        sourceId: 'chat_1:high',
        sessionId: 'chat_1',
        // Reopen: a re-flag after the item was resolved must re-notify the care
        // team instead of dying on the (item_type, source, id) idempotency key.
        reopen: true,
      }),
    );
    // Detail carries category tags only, never transcript text.
    const detail = enqueueWorkItemMock.mock.calls[0][0].detail as Record<string, unknown>;
    expect(JSON.stringify(detail)).not.toContain(turn.content);
  });

  it('does NOT enqueue for anonymous sessions (no care team; avoids IRB-org fallback noise)', async () => {
    getSessionAccessInfoMock.mockResolvedValue({ status: 'active', user_id: null, session_type: 'voice' });
    risk(90, 'high');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true); // flagging/paging still happen
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the session row is missing', async () => {
    getSessionAccessInfoMock.mockResolvedValue(null);
    risk(90, 'high');
    await runCrisisPipeline(TURN, 'realtime');
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
  });

  it('a failing owner lookup skips the enqueue but never breaks the flag path', async () => {
    getSessionAccessInfoMock.mockRejectedValue(new Error('db down'));
    risk(90, 'high');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
    expect(enqueueWorkItemMock).not.toHaveBeenCalled();
  });
});

describe('runCrisisPipeline — summary-tier broadcasts', () => {
  // The broadcasts are fire-and-forget; flush pending microtasks/timers so
  // the emit assertions are deterministic.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('emits session:risk-score-updated (score+severity only) whenever risk is scored', async () => {
    risk(40, 'medium');
    await runCrisisPipeline(TURN, 'chat');
    await flush();
    const call = emitMock.mock.calls.find(([event]) => event === 'session:risk-score-updated');
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload).toMatchObject({ sessionId: 'chat_1', riskScore: 40, severity: 'medium' });
    expect(JSON.stringify(payload)).not.toContain(TURN.content);
  });

  it('emits a scrubbed session:crisis-event-created mirror on flag (no messageId, no message text)', async () => {
    risk(90, 'high', ['suicidal_ideation']);
    await runCrisisPipeline(TURN, 'realtime');
    await flush();
    const call = emitMock.mock.calls.find(([event]) => event === 'session:crisis-event-created');
    expect(call).toBeDefined();
    const payload = call![1] as Record<string, unknown>;
    expect(payload).toMatchObject({ sessionId: 'chat_1', severity: 'high', riskScore: 90 });
    expect(payload).not.toHaveProperty('messageId');
    expect(payload).not.toHaveProperty('message');
  });

  it('does not emit crisis-event-created when nothing was flagged', async () => {
    risk(30, 'low');
    await runCrisisPipeline(TURN, 'realtime');
    await flush();
    expect(emitMock.mock.calls.some(([event]) => event === 'session:crisis-event-created')).toBe(false);
  });
});

// ai-therapist-198: the structured ladder needs a deterministic demand, not
// just prose in the steering copy. The pipeline's job here is to ask on every
// scored turn and to merge the chat-channel demand into this turn's guidance.
describe('runCrisisPipeline — structured risk ladder', () => {
  it('asks for a ladder on both channels with the scored turn', async () => {
    risk(55, 'medium');
    await runCrisisPipeline(TURN, 'realtime');
    expect(maybeRequireRiskCheckMock).toHaveBeenCalledWith('chat_1', 55, 'medium', 'realtime');
    await runCrisisPipeline(TURN, 'chat');
    expect(maybeRequireRiskCheckMock).toHaveBeenCalledWith('chat_1', 55, 'medium', 'chat');
  });

  it('does not ask on a zero-risk turn', async () => {
    risk(0, 'none');
    await runCrisisPipeline(TURN, 'chat');
    expect(maybeRequireRiskCheckMock).not.toHaveBeenCalled();
  });

  it('chat: appends the ladder demand to the steering guidance for this turn', async () => {
    risk(45, 'medium');
    maybeRequireRiskCheckMock.mockResolvedValue('LADDER_DEMAND');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBe('CHAT_STEER_45\n\nLADDER_DEMAND');
  });

  it('chat: the demand is returned even when steering is on cooldown', async () => {
    risk(45, 'medium');
    shouldSteerMock.mockReturnValue(false);
    maybeRequireRiskCheckMock.mockResolvedValue('LADDER_DEMAND');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBe('LADDER_DEMAND');
  });

  it('realtime: guidance stays null (the demand went over the sideband)', async () => {
    risk(85, 'high');
    maybeRequireRiskCheckMock.mockResolvedValue(null);
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.steeringGuidance).toBeNull();
  });
});

describe('runCrisisPipeline — resilience', () => {
  it('never throws when analyzeMessageRisk rejects', async () => {
    analyzeMessageRiskMock.mockRejectedValue(new Error('LLM down'));
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r).toEqual({ riskScore: 0, severity: 'none', factors: [], flagged: false, steeringGuidance: null });
  });
});

// ai-therapist-299: a keyword-free turn that the assessor reads as high because
// of what the session already holds. The pipeline must escalate it exactly like
// a keyword turn the first time, and must not turn every later short answer in
// that session into another forced safety-protocol steer or another page.
describe('runCrisisPipeline — context-wake turns (ai-therapist-299)', () => {
  const contextRisk = (riskScore: number, severity: string) =>
    analyzeMessageRiskMock.mockResolvedValue({
      riskScore,
      severity,
      factors: ['stated intent'],
      breakdown: {},
      method: 'llm_context',
      contextWake: true,
    });
  const flaggedAt = (severity: string, score: number) =>
    getSessionCrisisStateMock.mockResolvedValue({
      crisis_flagged: true,
      crisis_severity: severity,
      crisis_risk_score: score,
    });

  it('medium-flagged session, statement of intent scored high: flags high and runs the high response (realtime)', async () => {
    flaggedAt('medium', 55);
    contextRisk(92, 'high');

    const r = await runCrisisPipeline(TURN, 'realtime');

    expect(r.flagged).toBe(true);
    expect(r.severity).toBe('high');
    expect(flagSessionCrisisMock).toHaveBeenCalledWith(
      'chat_1',
      'high',
      92,
      'system',
      'auto',
      expect.anything(),
      ['stated intent'],
      expect.any(String),
    );
    // executeGraduatedResponse is what logs high_risk_emergency, pages the
    // on-call and emits session:crisis-emergency.
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 92, { pageAlreadyRequested: true });
    // An escalation forces the steer past the cooldown, as a keyword turn does.
    expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 92, 'high', true);
  });

  it('the same on chat: safety-protocol guidance for this very reply, forced past the cooldown', async () => {
    flaggedAt('medium', 55);
    contextRisk(92, 'high');

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(shouldSteerMock).toHaveBeenCalledWith('chat_1', 92, true);
    expect(r.steeringGuidance).toBe('CHAT_HIGH_GUIDANCE');
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 92, { pageAlreadyRequested: true });
  });

  it('already flagged high: a later context-wake high turn does not page again or force the protocol again', async () => {
    flaggedAt('high', 92);
    contextRisk(90, 'high');
    shouldSteerMock.mockReturnValue(false); // inside the ordinary cooldown

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(shouldSteerMock).toHaveBeenCalledWith('chat_1', 90, false);
    expect(r.steeringGuidance).toBeNull();
    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(executeGraduatedResponseMock).not.toHaveBeenCalled();
  });

  it('already flagged high, realtime: the steer follows the ordinary cooldown too', async () => {
    flaggedAt('high', 92);
    contextRisk(90, 'high');

    await runCrisisPipeline(TURN, 'realtime');

    expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 90, 'high', false);
    expect(executeGraduatedResponseMock).not.toHaveBeenCalled();
  });

  it('a KEYWORD high turn in an already-high session still forces, exactly as before', async () => {
    flaggedAt('high', 92);
    risk(90, 'high');

    await runCrisisPipeline(TURN, 'chat');

    expect(shouldSteerMock).toHaveBeenCalledWith('chat_1', 90, true);
  });

  it('a retraction read as low by the assessor changes nothing: no flag, no response, flag untouched', async () => {
    flaggedAt('high', 85);
    contextRisk(30, 'low');

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(executeGraduatedResponseMock).not.toHaveBeenCalled();
  });

  it('a context turn scored 0 does nothing at all', async () => {
    flaggedAt('medium', 55);
    contextRisk(0, 'none');

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(r).toMatchObject({ riskScore: 0, flagged: false, steeringGuidance: null });
    expect(shouldSteerMock).not.toHaveBeenCalled();
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });
});

describe('runCrisisPipeline — reading the flag state must not cost the turn its steer', () => {
  it('still steers a high turn when the state read fails, then flags and pages it as unflagged (ai-therapist-366)', async () => {
    getSessionCrisisStateMock.mockRejectedValue(new Error('db down'));
    risk(90, 'high');

    const r = await runCrisisPipeline(TURN, 'realtime');

    expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 90, 'high', true);
    // It used to throw here: no flag, no page, NONE returned.
    expect(flagSessionCrisisMock).toHaveBeenCalled();
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90, { pageAlreadyRequested: true });
    expect(r).toMatchObject({ riskScore: 90, flagged: true });
  });
});

// ai-therapist-366: the pool now REJECTS where it used to wait forever, with
// pg-pool's acquire timeout or Postgres' statement timeout (57014). Each read
// or write on the way to the page must resolve toward paging and resources.
describe('runCrisisPipeline — a database timeout fails toward paging (ai-therapist-366)', () => {
  const acquireTimeout = () => new Error('timeout exceeded when trying to connect');
  const statementTimeout = () =>
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  it('demo check times out: the pipeline still runs and a high turn pages', async () => {
    isDemoAccountSessionMock.mockRejectedValue(acquireTimeout());
    risk(90, 'high');

    const r = await runCrisisPipeline(TURN, 'realtime');

    expect(analyzeMessageRiskMock).toHaveBeenCalled();
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90, { pageAlreadyRequested: true });
    expect(r).toMatchObject({ severity: 'high', flagged: true });
  });

  it('history read times out: scored without history, and a high turn pages', async () => {
    getRecentSessionMessagesMock.mockRejectedValue(statementTimeout());
    risk(90, 'high');

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(analyzeMessageRiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hi' }),
      [],
      expect.anything(),
    );
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90, { pageAlreadyRequested: true });
    expect(r.steeringGuidance).toBe('CHAT_HIGH_GUIDANCE');
  });

  it('crisis state read times out: flagged as if unflagged, and paged', async () => {
    getSessionCrisisStateMock.mockRejectedValue(acquireTimeout());
    risk(85, 'high');

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(flagSessionCrisisMock).toHaveBeenCalledWith(
      'chat_1',
      'high',
      85,
      'system',
      'auto',
      42,
      [],
      expect.any(String),
    );
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 85, { pageAlreadyRequested: true });
    expect(r.flagged).toBe(true);
  });

  it('flag write times out (acquire): the graduated response (page + resources) still runs', async () => {
    flagSessionCrisisMock.mockRejectedValue(acquireTimeout());
    risk(90, 'high');

    const r = await runCrisisPipeline(TURN, 'realtime');

    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90, { pageAlreadyRequested: true });
    expect(r).toMatchObject({ severity: 'high', flagged: true });
  });

  it('a HIGH flag write that fails is retried in the background, with the same flag (ai-therapist-369)', async () => {
    flagSessionCrisisMock.mockRejectedValueOnce(acquireTimeout()).mockResolvedValue(undefined);
    risk(90, 'high', ['explicit_intent']);

    await runCrisisPipeline(TURN, 'realtime');

    expect(retryCrisisRecordMock).toHaveBeenCalledTimes(1);
    const retry = retryCrisisRecordMock.mock.calls[0][0] as { what: string; sessionId: string; write: () => unknown };
    expect(retry).toMatchObject({ what: 'crisis flag', sessionId: 'chat_1' });
    await retry.write();
    const [first, again] = flagSessionCrisisMock.mock.calls;
    expect(again.slice(0, 8)).toEqual(first.slice(0, 8));
    // ai-therapist-373: the retry carries the first attempt's time, so a staff
    // unflag after it wins.
    expect(again[8]).toEqual({ retry: true, attemptedAt: expect.any(Date) });
  });

  it('a medium flag write that fails is not retried (a late medium write could lower a newer high)', async () => {
    flagSessionCrisisMock.mockRejectedValue(acquireTimeout());
    risk(55, 'medium');
    await runCrisisPipeline(TURN, 'realtime');
    expect(retryCrisisRecordMock).not.toHaveBeenCalled();
  });

  it('flag write times out (statement): the graduated response still runs', async () => {
    flagSessionCrisisMock.mockRejectedValue(statementTimeout());
    risk(80, 'high');

    await runCrisisPipeline(TURN, 'chat');

    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 80, { pageAlreadyRequested: true });
  });

  it('every read and write times out at once: a high turn still reaches the graduated response', async () => {
    isDemoAccountSessionMock.mockRejectedValue(acquireTimeout());
    getRecentSessionMessagesMock.mockRejectedValue(acquireTimeout());
    getSessionCrisisStateMock.mockRejectedValue(acquireTimeout());
    flagSessionCrisisMock.mockRejectedValue(acquireTimeout());
    getSessionAccessInfoMock.mockRejectedValue(acquireTimeout());
    risk(95, 'high');

    const r = await runCrisisPipeline(TURN, 'realtime');

    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 95, { pageAlreadyRequested: true });
    expect(r).toMatchObject({ riskScore: 95, severity: 'high', flagged: true });
  });
});
