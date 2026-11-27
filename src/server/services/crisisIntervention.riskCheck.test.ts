// Deterministic risk-ladder trigger (ai-therapist-198).
//
// The structured ladder (run_risk_check) fired twice in the platform's life
// because nothing ever asked for it. These tests pin the two halves of the
// fix: every elevated-risk steer NAMES the tool, and crossing the configured
// score with no ladder logged produces a recorded, channel-appropriate demand.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQueryMock, logInterventionActionMock, sessionHasRiskCheckMock, getSystemConfigMock, sidebandManagerMock } =
  vi.hoisted(() => ({
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
  CHAT_RISK_CHECK_REPLY_GUIDANCE,
  RISK_CHECK_REQUIRED_GUIDANCE,
  chatRiskCheckRequiredGuidance,
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

// ai-therapist-401: the first reply to passive ideation sometimes carried no
// crisis line. The ladder requirement said "ask ONE question" and the medium
// steer left the lines to "if anything suggests thoughts of self-harm".
describe('a medium typed-chat turn is told to give the crisis lines AND ask its one question', () => {
  const LINES = ['call or text 988', 'text HOME to 741741'];

  it('the medium steer asks for the lines unconditionally, with one safety question', () => {
    const guidance = buildChatSteeringGuidance(55, 'medium');
    for (const line of LINES) expect(guidance).toContain(line);
    expect(guidance).not.toContain('If anything suggests');
    expect(guidance).toContain('ask one direct question about their safety');
    expect(guidance).toContain('Tell them you are staying right here with them.');
    expect(guidance).toContain('(score 55/100)');
  });

  it('the low steer keeps its conditional wording', () => {
    const guidance = buildChatSteeringGuidance(30, 'low');
    expect(guidance).toContain('If anything suggests thoughts of self-harm');
    expect(guidance).not.toContain('741741');
  });

  it('the ladder requirement for chat says one question is not the whole reply, and carries the lines by itself', () => {
    // By itself: the requirement is also sent on turns where the steer is
    // inside its cooldown and is not sent.
    const guidance = chatRiskCheckRequiredGuidance();
    expect(guidance).toContain('ask ONE gentle, direct question');
    expect(guidance).toContain('one assessment question per reply, not that the reply is only a question');
    for (const line of LINES) expect(guidance).toContain(line);
    expect(guidance).toContain('Do not leave the crisis lines for a later turn.');
  });

  it('the voice ladder requirement is unchanged: the chat sentences are not in it', () => {
    expect(RISK_CHECK_REQUIRED_GUIDANCE).not.toContain(CHAT_RISK_CHECK_REPLY_GUIDANCE);
    expect(RISK_CHECK_REQUIRED_GUIDANCE).not.toContain('741741');
  });

  it('the high chat protocol tells the model to say it is staying', () => {
    expect(CHAT_SAFETY_PROTOCOL_GUIDANCE).toContain('tell them you are staying right here with them');
    expect(CHAT_SAFETY_PROTOCOL_GUIDANCE).toContain('offer to stay while they call or text');
    // Measured: with the staying sentence alone, the question about company
    // (Crisis Protocol) dropped from 4 of 5 runs to 1 of 5; the steer names it.
    expect(CHAT_SAFETY_PROTOCOL_GUIDANCE).toContain('ask whether someone could be with them in person');
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
    // Chat gets the shared requirement plus what the reply itself must hold (ai-therapist-401).
    expect(guidance).toBe(chatRiskCheckRequiredGuidance());
    expect(guidance).toBe(`${RISK_CHECK_REQUIRED_GUIDANCE} ${CHAT_RISK_CHECK_REPLY_GUIDANCE}`);
    expect(guidance).toContain('run_risk_check');
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({
        trigger: 'risk_check_required',
        channel: 'chat',
        threshold: 40,
        riskScore: 40,
        delivered: true,
      }),
    );
  });

  it('realtime: injects over the sideband and returns null (no same-turn string)', async () => {
    const s = freshSession();
    expect(await maybeRequireRiskCheck(s, 80, 'high', 'realtime')).toBeNull();
    expect(sidebandManagerMock.tryInject).toHaveBeenCalledWith(s, 'system', RISK_CHECK_REQUIRED_GUIDANCE, false);
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({
        trigger: 'risk_check_required',
        channel: 'realtime',
        delivered: true,
      }),
    );
  });

  it('realtime: an undeliverable demand is still RECORDED, as delivered:false', async () => {
    const s = freshSession();
    sidebandManagerMock.tryInject.mockResolvedValue(false);
    await maybeRequireRiskCheck(s, 80, 'high', 'realtime');
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({
        trigger: 'risk_check_required',
        delivered: false,
      }),
    );
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
