// maybeSteerSession and the spoken crisis line (voiceCrisisLine.service.ts,
// ai-therapist-406): the first medium steer about the participant's own risk
// asks the voice model to say 988 aloud, once; later steers do not repeat the
// request unless the line was not said, and never more than twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock, logInterventionActionMock, sidebandManagerMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  logInterventionActionMock: vi.fn(async () => undefined),
  sidebandManagerMock: {
    getActiveConnections: vi.fn(() => [] as string[]),
    isConnected: vi.fn(() => true),
    injectMessage: vi.fn(async () => undefined),
    tryInject: vi.fn(async () => true),
    headsUpEligible: vi.fn(() => false),
    participantLastSpokeAt: vi.fn(() => 0),
  },
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sidebandManagerMock }));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: vi.fn(async () => ({ features: { chat_enabled: true } })),
  resolveVendorCeilingMinutes: vi.fn(async () => 60),
}));
vi.mock('../db/index.js', () => ({
  getSessionAccessInfo: vi.fn(),
  sessionHasRiskCheck: vi.fn(async () => false),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));

const ci = await import('./crisisIntervention.service.js');
const cl = await import('./voiceCrisisLine.service.js');
const { rememberTurn, _resetRecentTurnsForTests } = await import('../utils/recentTurns.js');

const T0 = 1_800_000_000_000;
let n = 0;
const fresh = () => `live_crisis_line_${++n}`;
const injected = () => sidebandManagerMock.injectMessage.mock.calls.map((c) => (c as unknown[])[2] as string);
const withLine = (score: number) => `${ci.steeringGuidance(score, 'medium')} ${cl.VOICE_CRISIS_LINE_GUIDANCE}`;
const pastCooldown = () => vi.setSystemTime(Date.now() + ci.STEER_COOLDOWN_MS + 1_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  cl._resetVoiceCrisisLineForTests();
  _resetRecentTurnsForTests();
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [] });
  logInterventionActionMock.mockClear();
  sidebandManagerMock.injectMessage.mockClear();
  sidebandManagerMock.injectMessage.mockResolvedValue(undefined);
  sidebandManagerMock.tryInject.mockClear();
  sidebandManagerMock.tryInject.mockResolvedValue(true);
  sidebandManagerMock.isConnected.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('maybeSteerSession and the spoken crisis line', () => {
  it('the first medium steer asks for it, and the row says so', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([withLine(55)]);
    expect(logInterventionActionMock).toHaveBeenCalledWith(s, 'risk_steering', {
      riskScore: 55,
      severity: 'medium',
      delivered: true,
      crisisLine: 'requested',
    });
  });

  it('a later medium steer does not ask again once the assistant has said the number', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    vi.setSystemTime(Date.now() + 5_000);
    rememberTurn(
      s,
      'assistant',
      'That sounds so heavy. You can call or text 988 any time. Are you thinking of suicide?',
    );
    pastCooldown();
    await ci.maybeSteerSession(s, 50, 'medium');
    expect(injected()).toEqual([withLine(55), ci.steeringGuidance(50, 'medium')]);
    expect(logInterventionActionMock).toHaveBeenLastCalledWith(s, 'risk_steering', {
      riskScore: 50,
      severity: 'medium',
      delivered: true,
    });
  });

  it('asks once more when the reply did not name it, and never a third time', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    vi.setSystemTime(Date.now() + 5_000);
    rememberTurn(s, 'assistant', "I'm here with you. Are you having thoughts of suicide?");
    pastCooldown();
    await ci.maybeSteerSession(s, 52, 'medium');
    pastCooldown();
    await ci.maybeSteerSession(s, 48, 'medium');
    expect(injected()).toEqual([withLine(55), withLine(52), ci.steeringGuidance(48, 'medium')]);
  });

  it('is not requested on every risky turn: a turn inside the cooldown sends nothing', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    vi.setSystemTime(Date.now() + 20_000);
    await ci.maybeSteerSession(s, 58, 'medium');
    expect(injected()).toEqual([withLine(55)]);
  });

  it('low and high steers are unchanged', async () => {
    const low = fresh();
    await ci.maybeSteerSession(low, 30, 'low');
    const high = fresh();
    await ci.maybeSteerSession(high, 90, 'high');
    expect(injected()).toEqual([ci.steeringGuidance(30, 'low'), ci.steeringGuidance(90, 'high')]);
    // Neither used up the request: the session's first medium steer still asks.
    pastCooldown();
    await ci.maybeSteerSession(low, 55, 'medium');
    expect(injected()[2]).toBe(withLine(55));
  });

  it("is not added to a steer about someone else's crisis or about harming another person", async () => {
    const third = fresh();
    await ci.maybeSteerSession(third, 55, 'medium', false, ci.THIRD_PARTY_GUIDANCE, 'third_party');
    const others = fresh();
    await ci.maybeSteerSession(others, 55, 'medium', false, ci.HARM_TO_OTHERS_GUIDANCE, 'harm_to_others');
    expect(injected()).toEqual([ci.THIRD_PARTY_GUIDANCE, ci.HARM_TO_OTHERS_GUIDANCE]);
  });

  it('a steer that never left does not count as a request', async () => {
    const s = fresh();
    sidebandManagerMock.injectMessage.mockRejectedValueOnce(new Error('socket closed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ci.maybeSteerSession(s, 55, 'medium');
    pastCooldown();
    await ci.maybeSteerSession(s, 55, 'medium');
    pastCooldown();
    rememberTurn(s, 'assistant', 'Are you having thoughts of suicide?');
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([withLine(55), withLine(55), withLine(55)]);
    vi.restoreAllMocks();
  });

  it('a steer held for a socket carries the request and counts when it is delivered', async () => {
    const s = fresh();
    sidebandManagerMock.isConnected.mockReturnValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([]);
    sidebandManagerMock.isConnected.mockReturnValue(true);
    expect(await ci.deliverPendingSteer(s)).toBe(true);
    expect(sidebandManagerMock.tryInject).toHaveBeenCalledWith(s, 'system', withLine(55), false);
    expect(logInterventionActionMock).toHaveBeenLastCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ delivered: true, deliveredOn: 'socket_ready', crisisLine: 'requested' }),
    );
    vi.setSystemTime(Date.now() + 5_000);
    rememberTurn(s, 'assistant', 'You can call or text 988 any time.');
    pastCooldown();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([ci.steeringGuidance(55, 'medium')]);
    vi.restoreAllMocks();
  });

  it('fits in one append with the keep-speaking line', () => {
    const room = ci.LIVE_STEER_MAX_CHARS - ci.KEEP_SPEAKING_RESERVE;
    expect(withLine(64).length).toBeLessThanOrEqual(room);
    expect(`${ci.RISK_CHECK_REQUIRED_GUIDANCE} ${cl.VOICE_CRISIS_LINE_GUIDANCE}`.length).toBeLessThanOrEqual(room);
  });
});

describe('the risk-check requirement sent on the same turn', () => {
  const restated = `${ci.RISK_CHECK_REQUIRED_GUIDANCE} ${cl.VOICE_CRISIS_LINE_GUIDANCE}`;
  const required = () =>
    sidebandManagerMock.tryInject.mock.calls
      .map((c) => (c as unknown[])[2] as string)
      .filter((t) => t.startsWith(ci.RISK_CHECK_REQUIRED_GUIDANCE));

  it('restates the sentence when the steer just asked for it, and that is not a second request', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    vi.setSystemTime(Date.now() + 40);
    await ci.maybeRequireRiskCheck(s, 55, 'medium', 'realtime');
    expect(required()).toEqual([restated]);
    expect(logInterventionActionMock).toHaveBeenLastCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ trigger: 'risk_check_required', delivered: true, crisisLine: 'restated' }),
    );
    // Still one request: a later steer may ask once more if the line was not said.
    vi.setSystemTime(Date.now() + 5_000);
    rememberTurn(s, 'assistant', 'Are you having thoughts of suicide?');
    pastCooldown();
    await ci.maybeSteerSession(s, 55, 'medium');
    pastCooldown();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([withLine(55), withLine(55), ci.steeringGuidance(55, 'medium')]);
    ci.clearSteeringState(s);
  });

  it('is sent as written when no steer asked for the line on this turn', async () => {
    const noSteer = fresh();
    await ci.maybeRequireRiskCheck(noSteer, 55, 'medium', 'realtime');
    const high = fresh();
    await ci.maybeSteerSession(high, 90, 'high');
    await ci.maybeRequireRiskCheck(high, 90, 'high', 'realtime');
    const later = fresh();
    await ci.maybeSteerSession(later, 55, 'medium');
    vi.setSystemTime(Date.now() + cl.VOICE_CRISIS_LINE_SAME_TURN_MS + 1_000);
    await ci.maybeRequireRiskCheck(later, 55, 'medium', 'realtime');
    expect(required()).toEqual([
      ci.RISK_CHECK_REQUIRED_GUIDANCE,
      ci.RISK_CHECK_REQUIRED_GUIDANCE,
      ci.RISK_CHECK_REQUIRED_GUIDANCE,
    ]);
    for (const id of [noSteer, high, later]) ci.clearSteeringState(id);
  });

  it('typed chat gets its own form of the requirement, without the spoken sentence', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    const chat = await ci.maybeRequireRiskCheck(s, 55, 'medium', 'chat');
    expect(chat).toBe(ci.chatRiskCheckRequiredGuidance());
    expect(chat).not.toContain(cl.VOICE_CRISIS_LINE_GUIDANCE);
    ci.clearSteeringState(s);
  });
});
