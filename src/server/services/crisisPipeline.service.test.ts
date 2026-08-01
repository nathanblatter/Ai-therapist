import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock every collaborator so the shared pipeline runs without a DB or network.
// The pipeline's job is orchestration: demo skip, steering delivery per
// channel, and the graduated-flag decision matrix.
const {
  analyzeMessageRiskMock, flagSessionCrisisMock, logInterventionActionMock,
  maybeSteerSessionMock, shouldSteerMock, buildChatSteeringGuidanceMock,
  executeGraduatedResponseMock,
  getRecentSessionMessagesMock, getSessionCrisisStateMock, getSessionIsDemoMock,
} = vi.hoisted(() => ({
  analyzeMessageRiskMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  maybeSteerSessionMock: vi.fn(),
  shouldSteerMock: vi.fn(),
  buildChatSteeringGuidanceMock: vi.fn(),
  executeGraduatedResponseMock: vi.fn(),
  getRecentSessionMessagesMock: vi.fn(),
  getSessionCrisisStateMock: vi.fn(),
  getSessionIsDemoMock: vi.fn(),
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
  executeGraduatedResponse: executeGraduatedResponseMock,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: getRecentSessionMessagesMock,
  getSessionCrisisState: getSessionCrisisStateMock,
  getSessionIsDemo: getSessionIsDemoMock,
}));

const { runCrisisPipeline } = await import('./crisisPipeline.service.js');

const emitMock = vi.fn();
const toMock = vi.fn(() => ({ emit: emitMock }));

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = { to: toMock };
  getSessionIsDemoMock.mockResolvedValue(false);
  getRecentSessionMessagesMock.mockResolvedValue([]);
  getSessionCrisisStateMock.mockResolvedValue({ crisis_flagged: false, crisis_severity: null, crisis_risk_score: null });
  buildChatSteeringGuidanceMock.mockImplementation((s: number) => `CHAT_STEER_${s}`);
  shouldSteerMock.mockReturnValue(true);
});

const TURN = { sessionId: 'chat_1', messageId: 42, content: 'hi' };

function risk(riskScore: number, severity: string, factors: string[] = []) {
  analyzeMessageRiskMock.mockResolvedValue({ riskScore, severity, factors, breakdown: {} });
}

describe('runCrisisPipeline — demo + none', () => {
  it('demo sessions skip everything and return NONE', async () => {
    getSessionIsDemoMock.mockResolvedValue(true);
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
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90);
  });

  it('does NOT re-flag when already flagged at same severity without +10 escalation', async () => {
    getSessionCrisisStateMock.mockResolvedValue({ crisis_flagged: true, crisis_severity: 'medium', crisis_risk_score: 55 });
    risk(58, 'medium'); // +3, below the +10 rule
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });

  it('re-flags on severity escalation medium→high', async () => {
    getSessionCrisisStateMock.mockResolvedValue({ crisis_flagged: true, crisis_severity: 'medium', crisis_risk_score: 55 });
    risk(80, 'high');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
  });

  it('re-flags on same severity but +10 score jump', async () => {
    getSessionCrisisStateMock.mockResolvedValue({ crisis_flagged: true, crisis_severity: 'medium', crisis_risk_score: 55 });
    risk(70, 'medium'); // +15 > +10
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(r.flagged).toBe(true);
  });
});

describe('runCrisisPipeline — steering delivery per channel', () => {
  it('realtime delegates to maybeSteerSession and returns null guidance', async () => {
    risk(40, 'medium');
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 40, 'medium');
    expect(r.steeringGuidance).toBeNull();
  });

  it('chat returns base steering guidance and logs risk_steering', async () => {
    risk(40, 'medium');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBe('CHAT_STEER_40');
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'risk_steering', expect.objectContaining({ channel: 'chat' }));
    expect(maybeSteerSessionMock).not.toHaveBeenCalled();
  });

  it('chat high severity uses the safety-protocol guidance and logs safety_protocol', async () => {
    risk(90, 'high');
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r.steeringGuidance).toBe('CHAT_HIGH_GUIDANCE');
    expect(logInterventionActionMock).toHaveBeenCalledWith('chat_1', 'safety_protocol', expect.objectContaining({ channel: 'chat' }));
  });

  it('chat honors the steering cooldown (shouldSteer false → no guidance)', async () => {
    shouldSteerMock.mockReturnValue(false);
    risk(40, 'medium');
    const r = await runCrisisPipeline(TURN, 'chat');
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
