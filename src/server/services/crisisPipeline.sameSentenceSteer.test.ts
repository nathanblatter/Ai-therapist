// One spoken sentence, one high steer.
//
// Seen live on 2026-11-21 (docs/gpt-live.md): a high turn scored twice 1.4 s
// apart sent the high steer twice. The 900 ms turn gap can close a turn before
// the participant's last words arrive; those words then come as a turn of
// their own, and the pipeline scores it joined to the part before it
// (stitchSplitTurnParts). The sentence is therefore scored twice, on purpose.
// Both scorings are high, a high turn forces its steer past the cooldown, and
// every instructions append interrupts the voice model: the second steer cut
// the reply the first one had just started.
//
// The pipeline and the intervention layer run for real here. The scorer, the
// database, the pager and the sideband are fakes; `injectMessage` is the
// sideband append itself.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  analyzeMessageRisk: vi.fn(),
  flagSessionCrisis: vi.fn(),
  logInterventionAction: vi.fn(),
  getRecentSessionMessages: vi.fn(),
  getSessionCrisisState: vi.fn(),
  pageHighRisk: vi.fn(),
  injectMessage: vi.fn(),
  tryInject: vi.fn(),
  connected: { value: true },
}));

vi.mock('../config/db.js', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: m.analyzeMessageRisk,
  flagSessionCrisis: m.flagSessionCrisis,
  logInterventionAction: m.logInterventionAction,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: m.getRecentSessionMessages,
  getSessionCrisisState: m.getSessionCrisisState,
  getSessionCheckin: vi.fn(async () => null),
  getSessionHighFlagSubjects: vi.fn(async () => ['own']),
  getSessionFlagEscalations: vi.fn(async () => []),
  recordRecoveryDisclosure: vi.fn(async () => ({ recorded: false })),
  incidentHasCrisisAdverseEvent: vi.fn(async () => true),
  isDemoAccountSession: vi.fn(async () => false),
  getSessionAccessInfo: vi.fn(async () => ({ status: 'active', user_id: null, session_type: 'voice' })),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./suppression.js', () => ({ sessionSuppressesSafetyPipeline: vi.fn(async () => false) }));
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: m.pageHighRisk,
  retryCrisisRecord: vi.fn(),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));
vi.mock('./minorSafeguard.service.js', () => ({
  detectMinorDisclosurePatterns: () => ({ matched: false, pattern: null }),
  confirmMinorDisclosure: vi.fn(),
  handleConfirmedMinor: vi.fn(),
  REALTIME_MINOR_GUIDANCE: 'MINOR_GUIDANCE',
  REALTIME_MINOR_SPEAK_NOW: 'SPEAK_NOW',
}));
vi.mock('./sidebandManager.service.js', () => ({
  sidebandManager: {
    isConnected: () => m.connected.value,
    getActiveConnections: () => (m.connected.value ? [SESSION] : []),
    injectMessage: m.injectMessage,
    tryInject: m.tryInject,
    headsUpEligible: () => false,
    participantLastSpokeAt: () => 0,
  },
}));
vi.mock('../utils/sessionAutoTerminate.js', () => ({
  liftLimitForCrisis: vi.fn(() => ({ lifted: false, previousLimitMinutes: null, ceilingMinutes: 60 })),
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn(async () => ({})),
  resolveVendorCeilingMinutes: vi.fn(async () => 60),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => null) }));

const SESSION = 'live_same_sentence';

const { runCrisisPipeline, _resetEarlyPageStateForTests } = await import('./crisisPipeline.service.js');
const { steeringGuidance, clearSteeringState, SAFETY_PROTOCOL_GUIDANCE, THIRD_PARTY_GUIDANCE } = await import(
  './crisisIntervention.service.js'
);
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
const { _forgetSessionAccountsForTests } = await import('../utils/sessionAccounts.js');
const { rememberSessionStart, rememberTurn, _resetRecentTurnsForTests } = await import('../utils/recentTurns.js');

type Row = { role: string; content: string; content_redacted: null; message_id: number; created_at: Date };
const T0 = Date.parse('2026-11-21T18:00:00Z');
const row = (message_id: number, role: string, content: string, atMs: number): Row => ({
  role,
  content,
  content_redacted: null,
  message_id,
  created_at: new Date(T0 + atMs),
});

/** The conversation as stored. A turn's history is everything up to its own row. */
let stored: Row[] = [];
/** The session's flag, as flagSessionCrisis leaves it. */
let flag: { crisis_flagged: boolean; crisis_severity: string | null; crisis_risk_score: number | null };
/** What the fake assessor says about a text. */
let verdict: (text: string) => Record<string, unknown>;

const HIGH = { riskScore: 85, severity: 'high', factors: ['intent'], breakdown: {} };
const MEDIUM = { riskScore: 55, severity: 'medium', factors: ['hopelessness'], breakdown: {} };
const NONE = { riskScore: 0, severity: 'none', factors: [], breakdown: {} };

const turn = (messageId: number) => {
  const mine = stored.find((r) => r.message_id === messageId);
  if (!mine) throw new Error(`no stored row ${messageId}`);
  return { sessionId: SESSION, messageId, content: mine.content };
};

/** Run a stored turn through the pipeline with the history it would have read. */
const score = (messageId: number) => {
  const upTo = stored.slice(0, stored.findIndex((r) => r.message_id === messageId) + 1);
  m.getRecentSessionMessages.mockResolvedValueOnce(upTo);
  return runCrisisPipeline(turn(messageId), 'realtime');
};

/** The appends that reached the voice model, by text. */
const appends = (): string[] => m.injectMessage.mock.calls.map((c) => String(c[2]));
const highSteers = (): string[] => appends().filter((t) => t === steeringGuidance(85, 'high'));

beforeEach(() => {
  vi.clearAllMocks();
  _resetEarlyPageStateForTests();
  _forgetSessionAccountsForTests();
  _resetRecentTurnsForTests();
  clearSteeringState(SESSION);
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = undefined;
  m.connected.value = true;
  flag = { crisis_flagged: false, crisis_severity: null, crisis_risk_score: null };
  verdict = (text) => (/kill myself/.test(text) ? HIGH : NONE);
  m.analyzeMessageRisk.mockImplementation(async (message: { content: string }) => verdict(message.content));
  m.getRecentSessionMessages.mockResolvedValue([]);
  m.getSessionCrisisState.mockImplementation(async () => ({ ...flag }));
  m.flagSessionCrisis.mockImplementation(async (_id: string, severity: string, riskScore: number) => {
    flag = { crisis_flagged: true, crisis_severity: severity, crisis_risk_score: riskScore };
    return 'written';
  });
  m.logInterventionAction.mockResolvedValue(undefined);
  m.pageHighRisk.mockResolvedValue({ outcome: 'paged' });
  m.injectMessage.mockResolvedValue(undefined);
  m.tryInject.mockResolvedValue(true);
  // "I have been thinking about how I would kill myself" closed as a turn, and
  // " you know?" arrived 1.4 s later as a turn of its own.
  stored = [
    row(1, 'assistant', 'What has been on your mind?', 0),
    row(2, 'user', 'I have been thinking about how I would kill myself', 5_000),
    row(3, 'user', ' you know?', 6_400),
  ];
});

describe('a sentence that arrives as two turns and is scored twice', () => {
  it('scores the second part joined to the first (the double scoring is intended)', async () => {
    await score(2);
    await score(3);
    expect(m.analyzeMessageRisk.mock.calls.map((c) => (c[0] as { content: string }).content)).toEqual([
      'I have been thinking about how I would kill myself',
      'I have been thinking about how I would kill myself you know?',
    ]);
  });

  it('sends the high steer once', async () => {
    await score(2);
    await score(3);
    expect(highSteers()).toHaveLength(1);
    // The first flag's safety protocol is the other append of a first high
    // turn, as before; nothing else was sent.
    expect(appends().filter((t) => t === SAFETY_PROTOCOL_GUIDANCE)).toHaveLength(1);
    expect(appends()).toHaveLength(2);
  });

  it('sends it once when the same stored turn is scored a second time', async () => {
    await score(2);
    await score(2);
    expect(highSteers()).toHaveLength(1);
  });

  it('sends it once when both scorings are in flight together, whichever finishes first', async () => {
    for (const firstDone of [2, 3]) {
      vi.clearAllMocks();
      _resetEarlyPageStateForTests();
      clearSteeringState(SESSION);
      flag = { crisis_flagged: false, crisis_severity: null, crisis_risk_score: null };
      const release = new Map<number, () => void>();
      m.analyzeMessageRisk.mockImplementation(
        (message: { content: string; message_id: number }) =>
          new Promise((resolve) => release.set(message.message_id, () => resolve(verdict(message.content)))),
      );
      const both = [score(2), score(3)];
      await vi.waitFor(() => expect(release.size).toBe(2));
      release.get(firstDone)?.();
      release.get(firstDone === 2 ? 3 : 2)?.();
      await Promise.all(both);
      expect(highSteers(), `scoring of turn ${firstDone} finished first`).toHaveLength(1);
    }
  });

  it('still sends it for the second part when the first one never reached the model', async () => {
    m.injectMessage.mockRejectedValueOnce(new Error('socket closed'));
    await score(2);
    expect(highSteers()).toHaveLength(1); // attempted, and it threw
    await score(3);
    expect(highSteers()).toHaveLength(2);
  });

  it('still sends it when the first part was held for a socket that was not open', async () => {
    m.connected.value = false;
    await score(2);
    expect(appends()).toHaveLength(0);
    m.connected.value = true;
    await score(3);
    expect(highSteers()).toHaveLength(1);
  });

  it('sends it once when the database is down and the sentence is joined from memory, with no stored ids', async () => {
    rememberSessionStart(SESSION);
    m.getRecentSessionMessages.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const said = (content: string, atMs: number) => {
      rememberTurn(SESSION, 'user', content, { at: T0 + atMs });
      return runCrisisPipeline({ sessionId: SESSION, messageId: null, content }, 'realtime');
    };
    rememberTurn(SESSION, 'assistant', 'What has been on your mind?', { at: T0 });
    await said('I have been thinking about how I would kill myself', 5_000);
    await said(' you know?', 6_400);
    expect(m.analyzeMessageRisk.mock.calls.map((c) => (c[0] as { content: string }).content)).toEqual([
      'I have been thinking about how I would kill myself',
      'I have been thinking about how I would kill myself you know?',
    ]);
    expect(highSteers()).toHaveLength(1);
    // A new sentence, later, is steered again.
    await said('I want to kill myself', 30_000);
    expect(highSteers()).toHaveLength(2);
  });

  it('covers a third part of the same sentence', async () => {
    stored.push(row(4, 'user', ' I mean it', 7_800));
    await score(2);
    await score(3);
    await score(4);
    expect(highSteers()).toHaveLength(1);
  });
});

describe('what the same-sentence rule must not hold back', () => {
  it('a later high turn, after the assistant has answered, is steered again', async () => {
    stored.push(row(4, 'assistant', 'I am glad you told me. Are you thinking about suicide right now?', 9_000));
    stored.push(row(5, 'user', 'Yes. I want to kill myself', 15_000));
    await score(2);
    await score(3);
    await score(5);
    expect(highSteers()).toHaveLength(2);
  });

  it('a later high turn with no reply in between, outside the split window, is steered again', async () => {
    stored.push(row(4, 'user', 'I really do want to kill myself', 20_000));
    await score(2);
    await score(3);
    await score(4);
    expect(highSteers()).toHaveLength(2);
  });

  it('a sentence whose first part was medium still gets the high steer when the whole of it is high', async () => {
    stored = [
      row(1, 'assistant', 'What has been on your mind?', 0),
      row(2, 'user', 'Everything feels hopeless and I think about how I would kill', 5_000),
      row(3, 'user', ' myself', 6_000),
    ];
    verdict = (text) => (/kill myself/.test(text) ? HIGH : /hopeless/.test(text) ? MEDIUM : NONE);
    await score(2);
    expect(appends().filter((t) => t.startsWith(steeringGuidance(55, 'medium')))).toHaveLength(1);
    expect(highSteers()).toHaveLength(0);
    await score(3);
    expect(highSteers()).toHaveLength(1);
  });

  it('a second part that is about someone else gets its own steer', async () => {
    stored[2] = row(3, 'user', ' and my sister says she will kill herself tonight', 6_400);
    verdict = (text) =>
      /my sister/.test(text)
        ? { ...HIGH, riskScore: 90, subject: 'third_party' }
        : /kill myself/.test(text)
          ? HIGH
          : NONE;
    await score(2);
    await score(3);
    expect(highSteers()).toHaveLength(1);
    expect(appends().filter((t) => t === THIRD_PARTY_GUIDANCE)).not.toHaveLength(0);
  });
});

describe('crisis alerting is unchanged by the same-sentence rule', () => {
  it('flags once, pages once and runs the high-risk response once, exactly as before', async () => {
    await score(2);
    await score(3);
    await _settleBackgroundForTests();
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(1);
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
    const actions = m.logInterventionAction.mock.calls.map((c) => c[1]);
    expect(actions.filter((a) => a === 'high_risk_emergency')).toHaveLength(1);
    expect(actions.filter((a) => a === 'auto_flag')).toHaveLength(1);
    expect(actions.filter((a) => a === 'safety_protocol')).toHaveLength(1);
    // One delivered risk-steering row: the steer that was sent.
    expect(actions.filter((a) => a === 'risk_steering')).toHaveLength(1);
  });

  it('a second part that escalates the sentence still pages for what it adds', async () => {
    stored[2] = row(3, 'user', ' tonight', 6_400);
    verdict = (text) =>
      /tonight/.test(text) ? { ...HIGH, riskScore: 95, acute: 'plan_or_time' } : /kill myself/.test(text) ? HIGH : NONE;
    await score(2);
    await score(3);
    await _settleBackgroundForTests();
    expect(m.pageHighRisk).toHaveBeenCalledTimes(2);
    expect(m.pageHighRisk.mock.calls[1][2]).toMatchObject({ escalation: 'plan_or_time' });
    // The level rule re-flags only above stored + 10; the escalation rule flags it.
    expect(m.flagSessionCrisis).toHaveBeenCalledTimes(2);
  });
});
