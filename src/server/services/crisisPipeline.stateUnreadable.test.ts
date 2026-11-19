import { describe, it, expect, beforeEach, vi } from 'vitest';

// ai-therapist-366 review: a crisis-state read that fails must not let a
// medium turn rewrite a session that is in fact flagged high
// (flagSessionCrisis writes the turn's severity unconditionally). The same
// collaborator mocks as crisisPipeline.service.test.ts, in a file of its own.
const {
  analyzeMessageRiskMock,
  flagSessionCrisisMock,
  executeGraduatedResponseMock,
  getSessionCrisisStateMock,
  isDemoAccountSessionMock,
  getRecentSessionMessagesMock,
  getSessionAccessInfoMock,
} = vi.hoisted(() => ({
  analyzeMessageRiskMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  executeGraduatedResponseMock: vi.fn(),
  getSessionCrisisStateMock: vi.fn(),
  isDemoAccountSessionMock: vi.fn(),
  getRecentSessionMessagesMock: vi.fn(),
  getSessionAccessInfoMock: vi.fn(),
}));

vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: analyzeMessageRiskMock,
  flagSessionCrisis: flagSessionCrisisMock,
  logInterventionAction: vi.fn(),
}));
vi.mock('./crisisIntervention.service.js', () => ({
  maybeSteerSession: vi.fn(),
  shouldSteer: vi.fn(() => true),
  buildChatSteeringGuidance: vi.fn((s: number) => `CHAT_STEER_${s}`),
  maybeRequireRiskCheck: vi.fn(async () => null),
  executeGraduatedResponse: executeGraduatedResponseMock,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
  subjectGuidance: () => null,
  subjectLabel: () => null,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: getRecentSessionMessagesMock,
  getSessionCrisisState: getSessionCrisisStateMock,
  getSessionHighFlagSubjects: vi.fn(async () => []),
  isDemoAccountSession: isDemoAccountSessionMock,
  getSessionAccessInfo: getSessionAccessInfoMock,
  getSessionCheckin: vi.fn(async () => null),
  recordRecoveryDisclosure: vi.fn(async () => ({ recorded: false, eventId: null, stampedScore: null })),
  incidentHasCrisisAdverseEvent: vi.fn(async () => false),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));
vi.mock('./crisisPaging.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crisisPaging.service.js')>()),
  pageHighRisk: vi.fn(async () => ({ outcome: 'paged' })),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => 1) }));

const { runCrisisPipeline } = await import('./crisisPipeline.service.js');

const TURN = { sessionId: 'chat_1', messageId: 42, content: 'hi' };
const acquireTimeout = () => new Error('timeout exceeded when trying to connect');

function risk(riskScore: number, severity: string) {
  analyzeMessageRiskMock.mockResolvedValue({ riskScore, severity, factors: [], breakdown: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
  isDemoAccountSessionMock.mockResolvedValue(false);
  getRecentSessionMessagesMock.mockResolvedValue([]);
  getSessionAccessInfoMock.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'voice' });
  getSessionCrisisStateMock.mockResolvedValue({
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: null,
  });
});

describe('runCrisisPipeline: an unreadable crisis state never lowers a flag (ai-therapist-366)', () => {
  it('a medium turn does not flag when the state could not be read', async () => {
    getSessionCrisisStateMock.mockRejectedValue(acquireTimeout());
    risk(55, 'medium');

    const r = await runCrisisPipeline(TURN, 'realtime');

    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(executeGraduatedResponseMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ severity: 'medium', flagged: false });
  });

  it('a high turn still flags and reaches the graduated response', async () => {
    getSessionCrisisStateMock.mockRejectedValue(acquireTimeout());
    risk(85, 'high');

    const r = await runCrisisPipeline(TURN, 'realtime');

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
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 85);
    expect(r.flagged).toBe(true);
  });

  it('a medium turn in a readable, unflagged session still flags (unchanged)', async () => {
    risk(55, 'medium');

    await runCrisisPipeline(TURN, 'realtime');

    expect(flagSessionCrisisMock).toHaveBeenCalledWith(
      'chat_1',
      'medium',
      55,
      'system',
      'auto',
      42,
      [],
      expect.any(String),
    );
  });
});
