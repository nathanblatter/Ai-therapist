import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock every collaborator so the shared pipeline runs without a DB or network.
// The pipeline's job is orchestration: demo skip, steering delivery per
// channel, and the graduated-flag decision matrix.
const {
  analyzeMessageRiskMock, flagSessionCrisisMock, logInterventionActionMock,
  maybeSteerSessionMock, shouldSteerMock, buildChatSteeringGuidanceMock,
  executeGraduatedResponseMock,
  getRecentSessionMessagesMock, getSessionCrisisStateMock, isDemoAccountSessionMock,
  getSessionAccessInfoMock, enqueueWorkItemMock,
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
  executeGraduatedResponse: executeGraduatedResponseMock,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: getRecentSessionMessagesMock,
  getSessionCrisisState: getSessionCrisisStateMock,
  isDemoAccountSession: isDemoAccountSessionMock,
  getSessionAccessInfo: getSessionAccessInfoMock,
  // Transitive imports of utils/adminBroadcast.js:
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: enqueueWorkItemMock }));

const { runCrisisPipeline } = await import('./crisisPipeline.service.js');

const emitMock = vi.fn();
const toMock = vi.fn(() => ({ emit: emitMock }));

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = { to: toMock };
  isDemoAccountSessionMock.mockResolvedValue(false);
  getRecentSessionMessagesMock.mockResolvedValue([]);
  getSessionCrisisStateMock.mockResolvedValue({ crisis_flagged: false, crisis_severity: null, crisis_risk_score: null });
  getSessionAccessInfoMock.mockResolvedValue({ status: 'active', user_id: 42, session_type: 'voice' });
  enqueueWorkItemMock.mockResolvedValue(null);
  buildChatSteeringGuidanceMock.mockImplementation((s: number) => `CHAT_STEER_${s}`);
  shouldSteerMock.mockReturnValue(true);
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

describe('runCrisisPipeline — crisis_flag work item', () => {
  it('enqueues a reopen-able pool item for a logged-in participant session', async () => {
    risk(90, 'high', ['suicidal_ideation']);
    const turn = { ...TURN, content: 'a distinctive participant utterance' };
    await runCrisisPipeline(turn, 'realtime');
    expect(enqueueWorkItemMock).toHaveBeenCalledWith(expect.objectContaining({
      itemType: 'crisis_flag',
      severity: 'urgent',
      sourceId: 'chat_1:high',
      sessionId: 'chat_1',
      // Reopen: a re-flag after the item was resolved must re-notify the care
      // team instead of dying on the (item_type, source, id) idempotency key.
      reopen: true,
    }));
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

describe('runCrisisPipeline — resilience', () => {
  it('never throws when analyzeMessageRisk rejects', async () => {
    analyzeMessageRiskMock.mockRejectedValue(new Error('LLM down'));
    const r = await runCrisisPipeline(TURN, 'chat');
    expect(r).toEqual({ riskScore: 0, severity: 'none', factors: [], flagged: false, steeringGuidance: null });
  });
});
