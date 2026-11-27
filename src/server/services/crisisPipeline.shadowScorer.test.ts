// The shadow risk scorer cannot change what the crisis pipeline does
// (ai-therapist-83). Each scenario runs the same participant turn through
// runCrisisPipeline several times: with the scorer off, with it answering the
// OPPOSITE of production, with the Decisions API failing, with it hanging, and
// with the scorer's own insert failing. The pipeline's result and every call
// it makes to steering, flagging, paging, the work queue, the adverse-event
// draft and the sockets must be identical in all of them, and the pipeline
// must return while the shadow call is still unanswered.
//
// The collaborators are mocked as in crisisPipeline.service.test.ts; the
// shadow scorer itself is the real module with its client, config and insert
// injected.
import { describe, it, expect, afterEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  pageHighRisk: vi.fn(async () => ({ outcome: 'paged' })),
  retryCrisisRecord: vi.fn(),
  recordRecoveryDisclosure: vi.fn(),
  incidentHasCrisisAdverseEvent: vi.fn(),
  draftAdverseEventFromCrisis: vi.fn(async () => 1),
  analyzeMessageRisk: vi.fn(),
  flagSessionCrisis: vi.fn(),
  logInterventionAction: vi.fn(),
  maybeSteerSession: vi.fn(),
  shouldSteer: vi.fn(),
  buildChatSteeringGuidance: vi.fn(),
  maybeRequireRiskCheck: vi.fn(),
  executeGraduatedResponse: vi.fn(),
  getRecentSessionMessages: vi.fn(),
  getSessionCrisisState: vi.fn(),
  isDemoAccountSession: vi.fn(),
  getSessionAccessInfo: vi.fn(),
  enqueueWorkItem: vi.fn(),
  emitCrisisResources: vi.fn(),
}));

vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: m.analyzeMessageRisk,
  flagSessionCrisis: m.flagSessionCrisis,
  logInterventionAction: m.logInterventionAction,
}));
vi.mock('./crisisIntervention.service.js', () => ({
  maybeSteerSession: m.maybeSteerSession,
  shouldSteer: m.shouldSteer,
  buildChatSteeringGuidance: m.buildChatSteeringGuidance,
  maybeRequireRiskCheck: m.maybeRequireRiskCheck,
  executeGraduatedResponse: m.executeGraduatedResponse,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
  subjectGuidance: () => null,
  subjectLabel: () => null,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: m.getRecentSessionMessages,
  getSessionCrisisState: m.getSessionCrisisState,
  getSessionHighFlagSubjects: vi.fn(async () => []),
  isDemoAccountSession: m.isDemoAccountSession,
  getSessionAccessInfo: m.getSessionAccessInfo,
  getSessionCheckin: vi.fn(async () => null),
  recordRecoveryDisclosure: m.recordRecoveryDisclosure,
  incidentHasCrisisAdverseEvent: m.incidentHasCrisisAdverseEvent,
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: m.enqueueWorkItem }));
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: m.pageHighRisk,
  retryCrisisRecord: m.retryCrisisRecord,
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: m.draftAdverseEventFromCrisis }));
vi.mock('./crisisResources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisResources.js')>()),
  emitCrisisResources: m.emitCrisisResources,
}));

const { runCrisisPipeline, _resetEarlyPageStateForTests } = await import('./crisisPipeline.service.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
const { _resetShadowScorerForTests, _settleShadowScorerForTests, _shadowInFlightForTests } = await import(
  './shadowRiskScorer.service.js'
);
const { SHADOW_PREDICATE_NAMES } = await import('./shadowRiskQuestions.js');

type Band = 'none' | 'low' | 'medium' | 'high';

function shadowAnswer(band: Band) {
  return {
    model: 'gpt-6-luna',
    answers: [
      {
        type: 'score',
        name: 'severity',
        score: 0,
        confidence: 1,
        probabilities: (['none', 'low', 'medium', 'high'] as const).map((label, value) => ({
          label,
          value,
          probability: label === band ? 1 : 0,
        })),
      },
      ...SHADOW_PREDICATE_NAMES.map((name) => ({ type: 'predicate', name, probability: band === 'high' ? 0.99 : 0 })),
    ],
    usage: { input_tokens: 3000, output_tokens: 0 },
  };
}

type ShadowMode = 'off' | 'not-started' | 'opposite' | 'api-down' | 'hangs' | 'insert-fails' | 'refuses';
const SHADOW_MODES: ShadowMode[] = ['off', 'not-started', 'opposite', 'api-down', 'hangs', 'insert-fails', 'refuses'];

interface Scenario {
  name: string;
  channel: 'chat' | 'realtime';
  riskScore: number;
  severity: Band;
  /** The session's flag before the turn. */
  prior?: { crisis_flagged: boolean; crisis_severity: string | null; crisis_risk_score: number | null };
}

const SCENARIOS: Scenario[] = [
  { name: 'a calm chat turn (score 0)', channel: 'chat', riskScore: 0, severity: 'none' },
  { name: 'a low chat turn (steer only)', channel: 'chat', riskScore: 30, severity: 'low' },
  { name: 'a medium chat turn (flag, no page)', channel: 'chat', riskScore: 55, severity: 'medium' },
  { name: 'a high chat turn (flag and page)', channel: 'chat', riskScore: 85, severity: 'high' },
  { name: 'a high voice turn (flag and page)', channel: 'realtime', riskScore: 85, severity: 'high' },
  { name: 'a calm voice turn', channel: 'realtime', riskScore: 0, severity: 'none' },
  {
    name: 'a high turn in a session already flagged high',
    channel: 'chat',
    riskScore: 92,
    severity: 'high',
    prior: { crisis_flagged: true, crisis_severity: 'high', crisis_risk_score: 85 },
  },
];

const OBSERVED = [
  'analyzeMessageRisk',
  'flagSessionCrisis',
  'logInterventionAction',
  'maybeSteerSession',
  'shouldSteer',
  'buildChatSteeringGuidance',
  'maybeRequireRiskCheck',
  'executeGraduatedResponse',
  'pageHighRisk',
  'retryCrisisRecord',
  'recordRecoveryDisclosure',
  'draftAdverseEventFromCrisis',
  'enqueueWorkItem',
  'emitCrisisResources',
] as const;

const HISTORY = [
  { role: 'user', content: 'It has been a rough week.' },
  { role: 'assistant', content: 'I am sorry to hear that. What happened?' },
];

let turnSeq = 0;

function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
      if (typeof v === 'function') return '[function]';
      if (this[key] instanceof Date) return '[date]';
      return v === undefined ? '[undefined]' : v;
    }),
  );
}

async function run(scenario: Scenario, mode: ShadowMode) {
  vi.clearAllMocks();
  _resetEarlyPageStateForTests();
  const emit = vi.fn();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
  m.isDemoAccountSession.mockResolvedValue(false);
  m.getRecentSessionMessages.mockResolvedValue(HISTORY);
  m.getSessionCrisisState.mockResolvedValue(
    scenario.prior ?? { crisis_flagged: false, crisis_severity: null, crisis_risk_score: null },
  );
  m.getSessionAccessInfo.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'voice' });
  m.enqueueWorkItem.mockResolvedValue(null);
  m.buildChatSteeringGuidance.mockImplementation((s: number) => `CHAT_STEER_${s}`);
  m.shouldSteer.mockReturnValue(true);
  m.maybeRequireRiskCheck.mockResolvedValue(null);
  m.recordRecoveryDisclosure.mockResolvedValue({ recorded: false, eventId: null, stampedScore: null });
  m.incidentHasCrisisAdverseEvent.mockResolvedValue(false);
  m.analyzeMessageRisk.mockResolvedValue({
    riskScore: scenario.riskScore,
    severity: scenario.severity,
    factors: ['f'],
    breakdown: {},
  });

  // The shadow scorer says the opposite of production wherever it answers.
  const opposite: Band = scenario.severity === 'high' ? 'none' : 'high';
  const create = vi.fn();
  const insert = vi.fn(async () => undefined);
  if (mode === 'api-down') create.mockRejectedValue(Object.assign(new Error('service unavailable'), { status: 503 }));
  else if (mode === 'hangs') create.mockReturnValue(new Promise(() => undefined));
  else if (mode === 'refuses') {
    create.mockResolvedValue({ answers: [{ type: 'refusal', name: 'severity' }], usage: {} });
  } else create.mockResolvedValue(shadowAnswer(opposite));
  if (mode === 'insert-fails') insert.mockRejectedValue(new Error('db down'));
  _resetShadowScorerForTests(
    {
      readConfig: async () => (mode === 'off' ? undefined : { enabled: true }),
      getClient: async () => ({ decisions: { create } }),
      insert,
      timeoutMs: 40,
    },
    mode !== 'not-started',
  );

  // The same session and message ids in every mode, so the calls compare.
  const turn = { sessionId: `chat_shadow_${turnSeq}`, messageId: 1000 + turnSeq, content: 'the same words' };
  const result = await runCrisisPipeline(turn, scenario.channel);
  const inFlightAtReturn = _shadowInFlightForTests();
  await _settleBackgroundForTests();
  // A copy that compares across runs: the mocks' own arrays are emptied by the
  // next run, callbacks have no stable identity, and clock values differ
  // between runs by construction.
  const calls = plain(Object.fromEntries(OBSERVED.map((name) => [name, m[name].mock.calls])));
  const emitted = plain(emit.mock.calls);
  await _settleShadowScorerForTests();
  return { result, calls, emitted, inFlightAtReturn, create, insert };
}

afterEach(async () => {
  await _settleShadowScorerForTests();
  await _settleBackgroundForTests();
  _resetShadowScorerForTests();
});

describe('the shadow scorer never changes the crisis pipeline', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: same result and same actions whatever the shadow scorer does`, async () => {
      turnSeq++;
      const baseline = await run(scenario, 'off');
      expect(baseline.create).not.toHaveBeenCalled();
      expect(baseline.insert).not.toHaveBeenCalled();
      expect(baseline.result.severity).toBe(scenario.severity);
      for (const mode of SHADOW_MODES.filter((x) => x !== 'off')) {
        const observed = await run(scenario, mode);
        expect(observed.result, `result with shadow ${mode}`).toEqual(baseline.result);
        expect(observed.calls, `actions with shadow ${mode}`).toEqual(baseline.calls);
        expect(observed.emitted, `socket events with shadow ${mode}`).toEqual(baseline.emitted);
      }
    });
  }

  it('a high turn is flagged and paged while the shadow scorer says none', async () => {
    turnSeq++;
    const r = await run(SCENARIOS[3], 'opposite');
    expect(r.result).toMatchObject({ severity: 'high', flagged: true });
    expect(m.flagSessionCrisis).toHaveBeenCalled();
    expect(m.pageHighRisk).toHaveBeenCalled();
    expect(r.insert).toHaveBeenCalledWith(
      expect.objectContaining({ productionSeverity: 'high', productionScore: 85, shadowSeverity: 'none' }),
    );
  });

  it('a calm turn is not flagged, steered or paged while the shadow scorer says high', async () => {
    turnSeq++;
    const r = await run(SCENARIOS[0], 'opposite');
    expect(r.result).toEqual({
      riskScore: 0,
      severity: 'none',
      factors: ['f'],
      flagged: false,
      steeringGuidance: null,
    });
    expect(m.flagSessionCrisis).not.toHaveBeenCalled();
    expect(m.pageHighRisk).not.toHaveBeenCalled();
    expect(m.maybeSteerSession).not.toHaveBeenCalled();
    expect(m.emitCrisisResources).not.toHaveBeenCalled();
    expect(r.insert).toHaveBeenCalledWith(
      expect.objectContaining({ productionSeverity: 'none', productionScore: 0, shadowSeverity: 'high' }),
    );
  });

  it('the pipeline returns while the Decisions API has not answered (it does not wait)', async () => {
    turnSeq++;
    const r = await run(SCENARIOS[3], 'hangs');
    // The pipeline had already returned its full result with the call open.
    expect(r.inFlightAtReturn).toBe(1);
    expect(r.result).toMatchObject({ severity: 'high', flagged: true });
    // The scorer's own deadline then closed it as an errored row.
    expect(r.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'errored', errorCode: 'timeout' }));
  });

  it('an outage is recorded as unknown, not as agreement', async () => {
    turnSeq++;
    const r = await run(SCENARIOS[3], 'api-down');
    expect(r.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'errored', errorCode: 'http_503', shadowSeverity: null }),
    );
  });

  it('is handed the scored text, the production verdict and the history the assessor was given', async () => {
    turnSeq++;
    const r = await run(SCENARIOS[2], 'opposite');
    const assessorHistory = m.analyzeMessageRisk.mock.calls[0][1];
    expect(assessorHistory).toEqual(HISTORY);
    const body = r.create.mock.calls[0][0] as { input: string };
    expect(body.input).toContain('Participant: It has been a rough week.');
    expect(body.input).toContain('Latest participant message:\n"the same words"');
    expect(r.insert).toHaveBeenCalledWith(
      expect.objectContaining({ productionScore: 55, productionSeverity: 'medium', messageId: 1000 + turnSeq }),
    );
  });

  it('a demo-account session is never shadow-scored', async () => {
    turnSeq++;
    const create = vi.fn();
    _resetShadowScorerForTests(
      { readConfig: async () => ({ enabled: true }), getClient: async () => ({ decisions: { create } }) },
      true,
    );
    vi.clearAllMocks();
    m.isDemoAccountSession.mockResolvedValue(true);
    m.getRecentSessionMessages.mockResolvedValue([]);
    await runCrisisPipeline({ sessionId: `demo_${turnSeq}`, messageId: 1, content: 'hello' }, 'chat');
    await _settleShadowScorerForTests();
    expect(create).not.toHaveBeenCalled();
  });
});
