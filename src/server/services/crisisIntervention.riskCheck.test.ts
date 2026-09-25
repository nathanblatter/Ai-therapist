// Deterministic risk-ladder trigger (ai-therapist-198).
//
// The structured ladder (run_risk_check) fired twice in the platform's life
// because nothing ever asked for it. These tests pin the two halves of the
// fix: every elevated-risk steer NAMES the tool, and crossing the configured
// score with no ladder logged produces a recorded, channel-appropriate demand.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  poolQueryMock, logInterventionActionMock, sessionHasRiskCheckMock,
  getSystemConfigMock, sidebandManagerMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  sessionHasRiskCheckMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  sidebandManagerMock: {
    getActiveConnections: vi.fn(() => [] as string[]),
    isConnected: vi.fn(() => false),
    injectMessage: vi.fn(),
    tryInject: vi.fn(),
  },
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: vi.fn() }));
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sidebandManagerMock }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
vi.mock('../db/index.js', () => ({
  sessionHasRiskCheck: sessionHasRiskCheckMock,
  isSandboxAccountSession: vi.fn(async () => false),
  // Transitive imports of utils/adminBroadcast.js:
  getSessionAccessInfo: vi.fn(),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));

const {
  maybeRequireRiskCheck,
  resolveRiskCheckMinScore,
  clearSteeringState,
  buildChatSteeringGuidance,
  CHAT_SAFETY_PROTOCOL_GUIDANCE,
  RISK_CHECK_REQUIRED_GUIDANCE,
} = await import('./crisisIntervention.service.js');

let sessionCounter = 0;
const freshSession = () => `sess_rc_${++sessionCounter}`;

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = undefined;
  getSystemConfigMock.mockResolvedValue({});
  sessionHasRiskCheckMock.mockResolvedValue(false);
  sidebandManagerMock.tryInject.mockResolvedValue(true);
});

describe('steering copy names the run_risk_check tool', () => {
  it('chat steering (low/medium) instructs the model to log the ladder', () => {
    const guidance = buildChatSteeringGuidance(45, 'medium');
    expect(guidance).toContain('run_risk_check');
    expect(guidance).toContain('moderate or above');
  });

  it('chat high-severity safety protocol instructs the model to log the ladder', () => {
    expect(CHAT_SAFETY_PROTOCOL_GUIDANCE).toContain('run_risk_check');
  });
});

describe('resolveRiskCheckMinScore', () => {
  it('defaults to the moderate boundary (40) when unconfigured', async () => {
    expect(await resolveRiskCheckMinScore()).toBe(40);
  });

  it('reads system_config crisis.risk_check_min_score (same blob as crisis.risk_model)', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis: { risk_check_min_score: 60 } });
    expect(await resolveRiskCheckMinScore()).toBe(60);
  });

  it('ignores out-of-range / non-numeric config rather than disabling the trigger', async () => {
    getSystemConfigMock.mockResolvedValue({ crisis: { risk_check_min_score: 5000 } });
    expect(await resolveRiskCheckMinScore()).toBe(40);
    getSystemConfigMock.mockResolvedValue({ crisis: { risk_check_min_score: 'soon' } });
    expect(await resolveRiskCheckMinScore()).toBe(40);
  });

  it('falls back to the default when config lookup throws', async () => {
    getSystemConfigMock.mockRejectedValue(new Error('db down'));
    expect(await resolveRiskCheckMinScore()).toBe(40);
  });
});

describe('maybeRequireRiskCheck', () => {
  it('does nothing below the threshold', async () => {
    const s = freshSession();
    expect(await maybeRequireRiskCheck(s, 39, 'low', 'chat')).toBeNull();
    expect(logInterventionActionMock).not.toHaveBeenCalled();
    expect(sessionHasRiskCheckMock).not.toHaveBeenCalled();
  });

  it('chat: returns the ladder demand and records the attempt', async () => {
    const s = freshSession();
    const guidance = await maybeRequireRiskCheck(s, 40, 'medium', 'chat');
    expect(guidance).toBe(RISK_CHECK_REQUIRED_GUIDANCE);
    expect(guidance).toContain('run_risk_check');
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'risk_steering', expect.objectContaining({
      trigger: 'risk_check_required', channel: 'chat', threshold: 40, riskScore: 40, delivered: true,
    }));
  });

  it('realtime: injects over the sideband and returns null (no same-turn string)', async () => {
    const s = freshSession();
    expect(await maybeRequireRiskCheck(s, 80, 'high', 'realtime')).toBeNull();
    expect(sidebandManagerMock.tryInject).toHaveBeenCalledWith(s, 'system', RISK_CHECK_REQUIRED_GUIDANCE, false);
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'risk_steering', expect.objectContaining({
      trigger: 'risk_check_required', channel: 'realtime', delivered: true,
    }));
  });

  it('realtime: an undeliverable demand is still RECORDED, as delivered:false', async () => {
    const s = freshSession();
    sidebandManagerMock.tryInject.mockResolvedValue(false);
    await maybeRequireRiskCheck(s, 80, 'high', 'realtime');
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'risk_steering', expect.objectContaining({
      trigger: 'risk_check_required', delivered: false,
    }));
  });

  it('never re-demands once the session has a ladder step', async () => {
    const s = freshSession();
    sessionHasRiskCheckMock.mockResolvedValue(true);
    expect(await maybeRequireRiskCheck(s, 90, 'high', 'chat')).toBeNull();
    expect(logInterventionActionMock).not.toHaveBeenCalled();
  });

  it('demands at most once per retry window (no per-turn nagging or log spam)', async () => {
    const s = freshSession();
    expect(await maybeRequireRiskCheck(s, 70, 'high', 'chat')).not.toBeNull();
    expect(await maybeRequireRiskCheck(s, 75, 'high', 'chat')).toBeNull();
    expect(logInterventionActionMock).toHaveBeenCalledTimes(1);
  });

  it('honours a raised threshold from config', async () => {
    const s = freshSession();
    getSystemConfigMock.mockResolvedValue({ crisis: { risk_check_min_score: 75 } });
    expect(await maybeRequireRiskCheck(s, 60, 'medium', 'chat')).toBeNull();
    expect(await maybeRequireRiskCheck(s, 80, 'high', 'chat')).not.toBeNull();
  });

  it('clearSteeringState releases the requirement marker for a session', async () => {
    const s = freshSession();
    await maybeRequireRiskCheck(s, 70, 'high', 'chat');
    clearSteeringState(s);
    expect(await maybeRequireRiskCheck(s, 70, 'high', 'chat')).not.toBeNull();
    expect(logInterventionActionMock).toHaveBeenCalledTimes(2);
  });

  it('is fail-soft: a lookup error never propagates into the pipeline', async () => {
    const s = freshSession();
    sessionHasRiskCheckMock.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await maybeRequireRiskCheck(s, 90, 'high', 'chat')).toBeNull();
    spy.mockRestore();
  });
});
