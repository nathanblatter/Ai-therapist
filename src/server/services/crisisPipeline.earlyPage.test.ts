// ai-therapist-369 item 2: a high turn is paged the moment it scores, before
// any of the pipeline's own reads and writes, and that page is the one the
// turn would have produced after them.
//
// Every database call here is a promise that does not settle until the test
// opens its gate (a database that has stopped answering). The clock is fake:
// the only time that passes is the 2 s deadline on the reads that shape the
// score (history, check-in), which a slow database runs into.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const gate = { promise: Promise.resolve(), opened: false };
  const reset = () => {
    gate.opened = false;
    gate.promise = new Promise<void>((resolve) => {
      open = () => {
        gate.opened = true;
        resolve();
      };
    });
  };
  reset();
  /** A database call: settles only once the gate is open. */
  const slow =
    <T>(value: T) =>
    () =>
      gate.promise.then(() => value);
  return {
    gate,
    reset,
    openGate: () => open(),
    slow,
    verdict: { value: {} as Record<string, unknown> },
    analyzeMessageRisk: vi.fn(),
    flagSessionCrisis: vi.fn(),
    logInterventionAction: vi.fn(),
    executeGraduatedResponse: vi.fn(),
    pageHighRisk: vi.fn(),
    getSessionCrisisState: vi.fn(),
    getRecentSessionMessages: vi.fn(),
    getSessionCheckin: vi.fn(),
    isDemoAccountSession: vi.fn(),
    recordRecoveryDisclosure: vi.fn(),
    emit: vi.fn(),
  };
});

vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: m.analyzeMessageRisk,
  flagSessionCrisis: m.flagSessionCrisis,
  logInterventionAction: m.logInterventionAction,
}));
vi.mock('./crisisIntervention.service.js', () => ({
  maybeSteerSession: vi.fn(() => m.gate.promise),
  shouldSteer: vi.fn(() => true),
  buildChatSteeringGuidance: vi.fn(() => 'STEER'),
  maybeRequireRiskCheck: vi.fn(() => m.gate.promise.then(() => null)),
  executeGraduatedResponse: m.executeGraduatedResponse,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
  subjectGuidance: () => null,
  subjectLabel: () => null,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: m.getRecentSessionMessages,
  getSessionCrisisState: m.getSessionCrisisState,
  getSessionHighFlagSubjects: vi.fn(() => m.gate.promise.then(() => [])),
  getSessionFlagEscalations: vi.fn(() => m.gate.promise.then(() => [])),
  isDemoAccountSession: m.isDemoAccountSession,
  getSessionAccessInfo: vi.fn(() => m.gate.promise.then(() => null)),
  getSessionCheckin: m.getSessionCheckin,
  recordRecoveryDisclosure: m.recordRecoveryDisclosure,
  incidentHasCrisisAdverseEvent: vi.fn(async () => false),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: m.pageHighRisk,
  retryCrisisRecord: vi.fn(),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => 1) }));

const { runCrisisPipeline, pageAtOnce, _resetEarlyPageStateForTests } = await import('./crisisPipeline.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
const { rememberSessionAccount, _forgetSessionAccountsForTests } = await import('../utils/sessionAccounts.js');
const { PAGE_LEVEL } = await import('./crisisPaging.service.js');

const SESSION = 'live_early';

type Subject = 'own' | 'third_party' | 'harm_to_others';
type Level = { name: string; score: number; acute?: 'plan_or_time' | 'attempt' };
const SUBJECTS: Subject[] = ['own', 'third_party', 'harm_to_others'];
const LEVELS: Level[] = [
  { name: 'high', score: 75 },
  { name: 'critical (90 or more)', score: 95 },
  { name: 'stated time or plan', score: 85, acute: 'plan_or_time' },
  { name: 'attempt in progress', score: 80, acute: 'attempt' },
];

function verdict(subject: Subject, level: Level, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    riskScore: level.score,
    severity: 'high',
    factors: ['f'],
    breakdown: {},
    ...(subject === 'third_party' ? { subject, thirdParty: true } : subject === 'harm_to_others' ? { subject } : {}),
    ...(level.acute ? { acute: level.acute } : {}),
    ...extra,
  };
}

/** The facts executeHighRiskResponse sends with the same verdict (the page
 *  the turn would have produced after its reads). */
function normalPathFacts(subject: Subject, level: Level): Record<string, unknown> {
  return {
    source: 'participant_turn',
    ...(subject === 'own' ? {} : { subject }),
    ...(level.acute ? { escalation: level.acute } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  m.reset();
  _resetEarlyPageStateForTests();
  _forgetSessionAccountsForTests();
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: m.emit })) };
  // The scorer: the verdict is known at once (onScored), and its own write of
  // the turn's risk row is as slow as everything else.
  m.analyzeMessageRisk.mockImplementation(
    async (_msg: unknown, _history: unknown, hooks?: { onScored?: (r: unknown) => void }) => {
      hooks?.onScored?.(m.verdict.value);
      await m.gate.promise;
      return m.verdict.value;
    },
  );
  m.getRecentSessionMessages.mockImplementation(m.slow([]));
  m.getSessionCheckin.mockImplementation(m.slow(null));
  m.isDemoAccountSession.mockImplementation(m.slow(false));
  m.getSessionCrisisState.mockImplementation(
    m.slow({ crisis_flagged: false, crisis_severity: null, crisis_risk_score: null }),
  );
  m.flagSessionCrisis.mockImplementation(m.slow(undefined));
  m.logInterventionAction.mockImplementation(m.slow(undefined));
  m.executeGraduatedResponse.mockImplementation(m.slow(undefined));
  m.recordRecoveryDisclosure.mockImplementation(m.slow({ recorded: false, eventId: null, stampedScore: null }));
  m.pageHighRisk.mockResolvedValue({ outcome: 'paged' });
});
afterEach(async () => {
  m.openGate();
  await vi.advanceTimersByTimeAsync(10_000);
  await _settleBackgroundForTests();
  vi.useRealTimers();
});

describe('the page is requested before any slow read resolves, for every subject and level', () => {
  for (const subject of SUBJECTS) {
    for (const level of LEVELS) {
      it(`${subject}, ${level.name}`, async () => {
        rememberSessionAccount(SESSION, 'participant');
        m.verdict.value = verdict(subject, level);
        const done = runCrisisPipeline({ sessionId: SESSION, messageId: 7, content: 'x' }, 'realtime');

        // The history and check-in reads have not answered; their 2 s
        // deadline passes, and the turn is scored without them.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(m.gate.opened).toBe(false);
        expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
        // The page carries what the graduated response would have sent:
        // the same subject, the same "what changed", the same level (the
        // level is derived from the score and the escalation).
        expect(m.pageHighRisk).toHaveBeenCalledWith(
          SESSION,
          level.score,
          expect.objectContaining(normalPathFacts(subject, level)),
        );
        const facts = m.pageHighRisk.mock.calls[0][2] as Record<string, unknown>;
        expect(facts['subject']).toBe(subject === 'own' ? undefined : subject);
        expect(facts['escalation']).toBe(level.acute);
        // The participant's card went out with it (not for harming others).
        const card = m.emit.mock.calls.some(([event]) => event === 'session:crisis-emergency');
        expect(card).toBe(subject !== 'harm_to_others');
        // Nothing after the verdict has run: the state read has not even
        // been answered, the graduated response has not been reached.
        expect(m.executeGraduatedResponse).not.toHaveBeenCalled();

        // The database answers. The turn flags and runs its response, which
        // is told the page has gone: no second request.
        m.openGate();
        await vi.advanceTimersByTimeAsync(10);
        await done;
        await _settleBackgroundForTests();
        expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
        expect(m.executeGraduatedResponse).toHaveBeenCalledWith(
          SESSION,
          'high',
          level.score,
          expect.objectContaining({ pageAlreadyRequested: true }),
        );
      });
    }
  }
});

describe('an early page never stands in for a worse one', () => {
  it('a later turn at a higher level or a later stage pages again at once', async () => {
    rememberSessionAccount(SESSION, 'participant');
    m.openGate();
    m.verdict.value = verdict('own', LEVELS[0]);
    await runCrisisPipeline({ sessionId: SESSION, messageId: 1, content: 'x' }, 'realtime');
    // The session is now flagged high (as the scorer reads it): an ordinary
    // high turn adds nothing and is left to the pipeline's rules...
    m.verdict.value = verdict('own', { name: 'high', score: 78 }, { sessionFlaggedHigh: true });
    await runCrisisPipeline({ sessionId: SESSION, messageId: 2, content: 'x' }, 'realtime');
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
    // ...a stated plan, an attempt, the critical range, or someone else
    // each page at once.
    for (const [subject, level] of [
      ['own', LEVELS[2]],
      ['own', LEVELS[3]],
      ['third_party', LEVELS[0]],
    ] as Array<[Subject, Level]>) {
      m.verdict.value = verdict(subject, level, { sessionFlaggedHigh: true });
      await runCrisisPipeline({ sessionId: SESSION, messageId: 3, content: 'x' }, 'realtime');
    }
    expect(m.pageHighRisk).toHaveBeenCalledTimes(4);
    expect(m.pageHighRisk.mock.calls.map((c) => (c[2] as { escalation?: string }).escalation ?? null)).toEqual([
      null,
      'plan_or_time',
      'attempt',
      null,
    ]);
  });

  it('a page that no channel accepted does not hold the next high turn back', async () => {
    rememberSessionAccount(SESSION, 'participant');
    m.openGate();
    m.pageHighRisk.mockResolvedValueOnce({ outcome: 'not_delivered' });
    m.verdict.value = verdict('own', LEVELS[1]);
    await runCrisisPipeline({ sessionId: SESSION, messageId: 1, content: 'x' }, 'realtime');
    await _settleBackgroundForTests();
    await runCrisisPipeline({ sessionId: SESSION, messageId: 2, content: 'x' }, 'realtime');
    expect(m.pageHighRisk).toHaveBeenCalledTimes(2);
  });
});

describe('pageAtOnce (pure rule)', () => {
  const wanted = (subject: Subject, level: number, stage: 0 | 1 | 2) => ({
    subject,
    level: level as 2 | 3,
    stage,
  });
  beforeEach(() => _resetEarlyPageStateForTests());

  it('pages whenever the session is not known to be flagged high, or nothing is known', () => {
    expect(pageAtOnce('s', wanted('own', PAGE_LEVEL.high, 0), false)).toBe(true);
    expect(pageAtOnce('s', wanted('own', PAGE_LEVEL.high, 0), null)).toBe(true);
    expect(pageAtOnce('s', wanted('own', PAGE_LEVEL.high, 0), undefined)).toBe(true);
  });

  it('leaves an ordinary high turn in a session known to be flagged high to the pipeline', () => {
    expect(pageAtOnce('s', wanted('own', PAGE_LEVEL.high, 0), true)).toBe(false);
    expect(pageAtOnce('s', wanted('own', PAGE_LEVEL.critical, 0), true)).toBe(true);
    expect(pageAtOnce('s', wanted('own', PAGE_LEVEL.high, 1), true)).toBe(true);
  });
});

describe('a demo account known at session start never pages, even when the database cannot answer (item 5)', () => {
  it('known demo: no read, no scoring, no page', async () => {
    rememberSessionAccount(SESSION, 'demo');
    m.verdict.value = verdict('own', LEVELS[1]);
    m.isDemoAccountSession.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const r = await runCrisisPipeline({ sessionId: SESSION, messageId: 1, content: 'x' }, 'realtime').then(
      (value) => value,
      () => null,
    );
    expect(r).toMatchObject({ severity: 'none', flagged: false });
    expect(m.isDemoAccountSession).not.toHaveBeenCalled();
    expect(m.analyzeMessageRisk).not.toHaveBeenCalled();
    expect(m.pageHighRisk).not.toHaveBeenCalled();
  });

  it('known participant: no demo read at all', async () => {
    rememberSessionAccount(SESSION, 'participant');
    m.openGate();
    m.verdict.value = verdict('own', LEVELS[0]);
    await runCrisisPipeline({ sessionId: SESSION, messageId: 1, content: 'x' }, 'realtime');
    expect(m.isDemoAccountSession).not.toHaveBeenCalled();
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
  });

  it('unknown session whose demo read fails: fails toward paging (genuinely unknown)', async () => {
    m.isDemoAccountSession.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    m.verdict.value = verdict('own', LEVELS[0]);
    const done = runCrisisPipeline({ sessionId: 'unknown_session', messageId: 1, content: 'x' }, 'realtime');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
    m.openGate();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  });

  it('unknown session whose demo read times out: also pages, after the read deadline', async () => {
    m.verdict.value = verdict('own', LEVELS[0]);
    const done = runCrisisPipeline({ sessionId: 'unknown_slow', messageId: 1, content: 'x' }, 'realtime');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(m.pageHighRisk).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(m.pageHighRisk).toHaveBeenCalledTimes(1);
    m.openGate();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  });
});
