import { describe, it, expect, beforeEach, vi } from 'vitest';

// The two voice-path fixes that live in the shared crisis pipeline:
//
//   ai-therapist-293  the crisis resource card goes to the participant the
//                     moment a turn scores high, before any slower crisis work;
//   ai-therapist-296  the realtime under-18 safeguard: confirmation starts
//                     alongside risk scoring, a failed steer no longer skips
//                     the session end, one API error is retried, and the
//                     goodbye is delivered so a full-duplex model says it now.
//
// Every collaborator is mocked; `order` records the sequence things happened in.
const {
  order,
  analyzeMessageRiskMock,
  flagSessionCrisisMock,
  logInterventionActionMock,
  maybeSteerSessionMock,
  maybeRequireRiskCheckMock,
  executeGraduatedResponseMock,
  getRecentSessionMessagesMock,
  getSessionCrisisStateMock,
  detectMinorMock,
  confirmMinorMock,
  handleConfirmedMinorMock,
  injectMessageMock,
  getActiveConnectionsMock,
} = vi.hoisted(() => ({
  order: [] as string[],
  analyzeMessageRiskMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  maybeSteerSessionMock: vi.fn(),
  maybeRequireRiskCheckMock: vi.fn(),
  executeGraduatedResponseMock: vi.fn(),
  getRecentSessionMessagesMock: vi.fn(),
  getSessionCrisisStateMock: vi.fn(),
  detectMinorMock: vi.fn(),
  confirmMinorMock: vi.fn(),
  handleConfirmedMinorMock: vi.fn(),
  injectMessageMock: vi.fn(),
  getActiveConnectionsMock: vi.fn(),
}));

vi.mock('./crisisDetection.service.js', () => ({
  analyzeMessageRisk: analyzeMessageRiskMock,
  flagSessionCrisis: flagSessionCrisisMock,
  logInterventionAction: logInterventionActionMock,
}));
vi.mock('./crisisIntervention.service.js', () => ({
  maybeSteerSession: maybeSteerSessionMock,
  shouldSteer: vi.fn(() => false),
  buildChatSteeringGuidance: vi.fn(),
  maybeRequireRiskCheck: maybeRequireRiskCheckMock,
  executeGraduatedResponse: executeGraduatedResponseMock,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: getRecentSessionMessagesMock,
  getSessionCrisisState: getSessionCrisisStateMock,
  isDemoAccountSession: vi.fn(async () => false),
  getSessionAccessInfo: vi.fn(async () => ({ status: 'active', user_id: 42, session_type: 'voice' })),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: vi.fn(async () => null) }));
vi.mock('./minorSafeguard.service.js', () => ({
  detectMinorDisclosurePatterns: detectMinorMock,
  confirmMinorDisclosure: confirmMinorMock,
  handleConfirmedMinor: handleConfirmedMinorMock,
  REALTIME_MINOR_GUIDANCE: 'MINOR_GUIDANCE',
  REALTIME_MINOR_SPEAK_NOW: 'SPEAK_NOW',
}));
vi.mock('./sidebandManager.service.js', () => ({
  sidebandManager: { injectMessage: injectMessageMock, getActiveConnections: getActiveConnectionsMock },
}));

const { runCrisisPipeline } = await import('./crisisPipeline.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');

const participantEmit = vi.fn((event: string) => {
  order.push(`emit:${event}`);
});
const adminEmit = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = {
    to: vi.fn((room: string) => ({ emit: room.startsWith('session:') ? participantEmit : adminEmit })),
  };
  getRecentSessionMessagesMock.mockResolvedValue([]);
  getSessionCrisisStateMock.mockImplementation(async () => {
    order.push('db:crisis-state');
    return { crisis_flagged: false, crisis_severity: null, crisis_risk_score: null };
  });
  maybeSteerSessionMock.mockImplementation(async () => {
    order.push('steer');
  });
  maybeRequireRiskCheckMock.mockResolvedValue(null);
  flagSessionCrisisMock.mockImplementation(async () => {
    order.push('db:flag');
  });
  logInterventionActionMock.mockImplementation(async () => {
    order.push('db:intervention');
  });
  executeGraduatedResponseMock.mockImplementation(async () => {
    order.push('graduated-response');
  });
  detectMinorMock.mockReturnValue({ matched: false, pattern: null });
  getActiveConnectionsMock.mockReturnValue(['live_1']);
  injectMessageMock.mockResolvedValue(undefined);
  handleConfirmedMinorMock.mockResolvedValue(undefined);
});

const TURN = { sessionId: 'live_1', messageId: 7, content: 'a participant turn' };

function risk(riskScore: number, severity: string) {
  analyzeMessageRiskMock.mockImplementation(async () => {
    order.push('risk-scored');
    return { riskScore, severity, factors: [], breakdown: {} };
  });
}

describe('crisis resources on a high turn (ai-therapist-293)', () => {
  it('reach the participant before steering, the flag write and every intervention log', async () => {
    risk(90, 'high');
    await runCrisisPipeline(TURN, 'realtime');

    const emitted = order.indexOf('emit:session:crisis-emergency');
    expect(emitted).toBeGreaterThan(-1);
    expect(order[emitted - 1]).toBe('risk-scored');
    for (const later of ['steer', 'db:crisis-state', 'db:flag', 'db:intervention', 'graduated-response']) {
      expect(order.indexOf(later)).toBeGreaterThan(emitted);
    }
    expect(participantEmit).toHaveBeenCalledWith(
      'session:crisis-emergency',
      expect.objectContaining({ sessionId: 'live_1', severity: 'high', riskScore: 90, reason: 'high_risk' }),
    );
  });

  it('are still delivered when everything after scoring fails', async () => {
    risk(90, 'high');
    maybeSteerSessionMock.mockRejectedValue(new Error('sideband gone'));
    await runCrisisPipeline(TURN, 'realtime');
    expect(participantEmit).toHaveBeenCalledWith('session:crisis-emergency', expect.anything());
  });

  it('are not sent for a medium turn', async () => {
    risk(55, 'medium');
    await runCrisisPipeline(TURN, 'realtime');
    expect(participantEmit).not.toHaveBeenCalledWith('session:crisis-emergency', expect.anything());
  });

  it('are sent once per session from the pipeline, so a closed card is not re-opened on every high turn', async () => {
    risk(90, 'high');
    await runCrisisPipeline(TURN, 'realtime');
    await runCrisisPipeline(TURN, 'realtime');
    expect(participantEmit.mock.calls.filter((c) => c[0] === 'session:crisis-emergency')).toHaveLength(1);
  });
});

describe('realtime under-18 safeguard (ai-therapist-296)', () => {
  const CONFIRMED = { isMinor: true, statedAge: 15, confidence: 'high', reasoning: '' };

  beforeEach(() => {
    risk(0, 'none');
    detectMinorMock.mockReturnValue({ matched: true, pattern: 'x' });
  });

  it('starts the confirmation before risk scoring finishes, and acts after it', async () => {
    let releaseRisk: () => void = () => {};
    analyzeMessageRiskMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRisk = () => {
            order.push('risk-scored');
            resolve({ riskScore: 0, severity: 'none', factors: [], breakdown: {} });
          };
        }),
    );
    confirmMinorMock.mockImplementation(async () => {
      order.push('minor-confirm-called');
      return CONFIRMED;
    });
    handleConfirmedMinorMock.mockImplementation(async () => {
      order.push('minor-handled');
    });

    const running = runCrisisPipeline(TURN, 'realtime');
    await vi.waitFor(() => expect(confirmMinorMock).toHaveBeenCalled());
    // Confirmation is already in flight while the risk assessor is still out.
    expect(order).toEqual(['minor-confirm-called']);
    expect(handleConfirmedMinorMock).not.toHaveBeenCalled();

    releaseRisk();
    await running;
    expect(order).toEqual(['minor-confirm-called', 'risk-scored', 'minor-handled']);
  });

  it('tells the voice model to say the goodbye now, then ends the session', async () => {
    confirmMinorMock.mockResolvedValue(CONFIRMED);
    await runCrisisPipeline(TURN, 'realtime');
    expect(injectMessageMock).toHaveBeenCalledWith('live_1', 'system', 'MINOR_GUIDANCE SPEAK_NOW', false);
    expect(handleConfirmedMinorMock).toHaveBeenCalledWith({
      sessionId: 'live_1',
      messageId: 7,
      channel: 'realtime',
      statedAge: 15,
    });
  });

  it('still ends the session when the goodbye steer cannot be delivered', async () => {
    confirmMinorMock.mockResolvedValue(CONFIRMED);
    injectMessageMock.mockRejectedValue(new Error('Live sideband connection not active'));
    await runCrisisPipeline(TURN, 'realtime');
    expect(handleConfirmedMinorMock).toHaveBeenCalledTimes(1);
  });

  it('still ends the session when there is no live sideband at all', async () => {
    confirmMinorMock.mockResolvedValue(CONFIRMED);
    getActiveConnectionsMock.mockReturnValue([]);
    await runCrisisPipeline(TURN, 'realtime');
    expect(injectMessageMock).not.toHaveBeenCalled();
    expect(handleConfirmedMinorMock).toHaveBeenCalledTimes(1);
  });

  it('retries the confirmation once after an API error', async () => {
    confirmMinorMock.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(CONFIRMED);
    await runCrisisPipeline(TURN, 'realtime');
    expect(confirmMinorMock).toHaveBeenCalledTimes(2);
    expect(handleConfirmedMinorMock).toHaveBeenCalledTimes(1);
  });

  it('fails open (session continues) when the confirmation keeps failing', async () => {
    confirmMinorMock.mockRejectedValue(new Error('503'));
    const r = await runCrisisPipeline(TURN, 'realtime');
    expect(confirmMinorMock).toHaveBeenCalledTimes(2);
    expect(handleConfirmedMinorMock).not.toHaveBeenCalled();
    expect(injectMessageMock).not.toHaveBeenCalled();
    expect(r.severity).toBe('none');
  });

  it('does not end a session on a not-minor or low-confidence verdict', async () => {
    confirmMinorMock.mockResolvedValue({ isMinor: false, statedAge: null, confidence: 'high', reasoning: '' });
    await runCrisisPipeline(TURN, 'realtime');
    confirmMinorMock.mockResolvedValue({ isMinor: true, statedAge: 15, confidence: 'low', reasoning: '' });
    await runCrisisPipeline(TURN, 'realtime');
    expect(handleConfirmedMinorMock).not.toHaveBeenCalled();
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it('is not run on the chat channel (the chat route owns that gate)', async () => {
    confirmMinorMock.mockResolvedValue(CONFIRMED);
    await runCrisisPipeline(TURN, 'chat');
    expect(detectMinorMock).not.toHaveBeenCalled();
    expect(handleConfirmedMinorMock).not.toHaveBeenCalled();
  });
});
