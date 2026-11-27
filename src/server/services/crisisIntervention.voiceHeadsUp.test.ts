// maybeSteerSession and the voice heads-up (voiceHeadsUp.service.ts): the
// line rides on the first medium or high risk steer of a GPT-Live session,
// once, only with the switch on; it goes alone when the steer is in its
// cooldown; a steer must never be lost to it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQueryMock, logInterventionActionMock, sidebandManagerMock, getSystemConfigMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  logInterventionActionMock: vi.fn(async () => undefined),
  getSystemConfigMock: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  sidebandManagerMock: {
    getActiveConnections: vi.fn(() => [] as string[]),
    isConnected: vi.fn(() => true),
    injectMessage: vi.fn(async () => undefined),
    tryInject: vi.fn(async () => true),
    headsUpEligible: vi.fn(() => true),
    participantLastSpokeAt: vi.fn(() => 0),
  },
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sidebandManagerMock }));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
  resolveVendorCeilingMinutes: vi.fn(async () => 60),
}));
vi.mock('../db/index.js', () => ({
  getSessionAccessInfo: vi.fn(),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));

const ci = await import('./crisisIntervention.service.js');
const hu = await import('./voiceHeadsUp.service.js');
const cl = await import('./voiceCrisisLine.service.js');

const ON = { features: { voice_heads_up_enabled: true, chat_enabled: true } };
let n = 0;
const fresh = () => `live_heads_up_${++n}`;
/** A session's first medium steer also asks for the spoken crisis line (voiceCrisisLine.service). */
const medium = (score: number) => `${ci.steeringGuidance(score, 'medium')} ${cl.VOICE_CRISIS_LINE_GUIDANCE}`;
const injected = () => sidebandManagerMock.injectMessage.mock.calls.map((c) => (c as unknown[])[2] as string);
const alone = () =>
  sidebandManagerMock.tryInject.mock.calls
    .map((c) => (c as unknown[])[2] as string)
    .filter((t) => t === hu.VOICE_HEADS_UP_STEER);

beforeEach(() => {
  hu._resetVoiceHeadsUpForTests();
  cl._resetVoiceCrisisLineForTests();
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [] });
  logInterventionActionMock.mockClear();
  getSystemConfigMock.mockReset();
  getSystemConfigMock.mockResolvedValue(ON);
  sidebandManagerMock.injectMessage.mockClear();
  sidebandManagerMock.tryInject.mockClear();
  sidebandManagerMock.isConnected.mockReturnValue(true);
  sidebandManagerMock.headsUpEligible.mockReturnValue(true);
});

describe('maybeSteerSession with the voice heads-up', () => {
  it('switch off (the default): the steer is exactly as before', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { chat_enabled: true } });
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([medium(55)]);
    expect(sidebandManagerMock.tryInject).not.toHaveBeenCalled();
    expect(sidebandManagerMock.headsUpEligible).not.toHaveBeenCalled();
  });

  it.each([
    ['false', { features: { voice_heads_up_enabled: false, chat_enabled: true } }],
    ['the string "true"', { features: { voice_heads_up_enabled: 'true' } }],
    ['1', { features: { voice_heads_up_enabled: 1 } }],
    ['features not an object', { features: 'voice_heads_up_enabled' }],
    ['features null', { features: null }],
    ['no features row', {}],
  ])('switch %s: medium and high steers, rows and texts exactly as before', async (_name, config) => {
    getSystemConfigMock.mockResolvedValue(config as Record<string, unknown>);
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    const h = fresh();
    await ci.maybeSteerSession(h, 90, 'high');
    expect(injected()).toEqual([medium(55), ci.steeringGuidance(90, 'high')]);
    expect(sidebandManagerMock.tryInject).not.toHaveBeenCalled();
    expect(logInterventionActionMock.mock.calls).toEqual([
      [s, 'risk_steering', { riskScore: 55, severity: 'medium', delivered: true, crisisLine: 'requested' }],
      [h, 'risk_steering', { riskScore: 90, severity: 'high', delivered: true }],
    ]);
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(hu.voiceHeadsUpPending(s) || hu.voiceHeadsUpPending(h)).toBe(false);
  });

  it('config read failing: the steer is exactly as before', async () => {
    getSystemConfigMock.mockRejectedValue(new Error('db down'));
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([medium(55)]);
    expect(sidebandManagerMock.tryInject).not.toHaveBeenCalled();
  });

  it('config read hanging (slow database, cold cache): the steer waits at most the switch bound', async () => {
    vi.useFakeTimers();
    try {
      getSystemConfigMock.mockImplementation(() => new Promise(() => undefined));
      const s = fresh();
      const steering = ci.maybeSteerSession(s, 55, 'medium');
      await vi.advanceTimersByTimeAsync(hu.SWITCH_DEADLINE_MS - 1);
      expect(injected()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await steering;
      expect(injected()).toEqual([medium(55)]);
      expect(sidebandManagerMock.tryInject).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['attempt', 'plan_or_time'] as const)(
    'a high turn stating %s never carries it, even as the first risky turn (emergency help opens that reply)',
    async (acute) => {
      const s = fresh();
      await ci.maybeSteerSession(s, 95, 'high', true, null, null, acute);
      expect(injected()).toEqual([ci.steeringGuidance(95, 'high')]);
      expect(sidebandManagerMock.tryInject).not.toHaveBeenCalled();
      expect(hu.voiceHeadsUpPending(s)).toBe(false);
      // A later turn without that observation may still carry it.
      await ci.maybeSteerSession(s, 80, 'high');
      expect(injected()[1]).toBe(`${ci.steeringGuidance(80, 'high')} ${hu.VOICE_HEADS_UP_GUIDANCE}`);
    },
  );

  it('first medium turn: attached to the risk steer, recorded on its row', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([`${medium(55)} ${hu.VOICE_HEADS_UP_GUIDANCE}`]);
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ delivered: true, voiceHeadsUp: 'attached' }),
    );
    expect(hu.voiceHeadsUpPending(s)).toBe(true);
  });

  it('a low turn never carries it', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 30, 'low');
    expect(injected()).toEqual([ci.steeringGuidance(30, 'low')]);
    expect(hu.voiceHeadsUpPending(s)).toBe(false);
  });

  it('the first high turn gets it too, when nothing came before', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 85, 'high');
    expect(injected()).toEqual([`${ci.steeringGuidance(85, 'high')} ${hu.VOICE_HEADS_UP_GUIDANCE}`]);
    expect(alone()).toHaveLength(0);
    expect(hu.voiceHeadsUpPending(s)).toBe(true);
  });

  it('once spoken, a later high steer goes out without it', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    hu.noteVoiceHeadsUpSpeech(s, hu.VOICE_HEADS_UP_EXAMPLE, true);
    sidebandManagerMock.injectMessage.mockClear();
    await ci.maybeSteerSession(s, 90, 'high');
    expect(injected()).toEqual([ci.steeringGuidance(90, 'high')]);
  });

  it('in the steer cooldown (an earlier low steer), the heads-up is sent on its own', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 30, 'low');
    sidebandManagerMock.injectMessage.mockClear();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([]);
    expect(alone()).toHaveLength(1);
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ trigger: hu.HEADS_UP_TRIGGER_REQUESTED, delivered: true }),
    );
    expect(hu.voiceHeadsUpPending(s)).toBe(true);
  });

  it('a steer too long to carry it in one append is followed by the heads-up on its own', async () => {
    const s = fresh();
    expect(ci.fitsWithHeadsUp(ci.HARM_TO_OTHERS_GUIDANCE)).toBe(false);
    await ci.maybeSteerSession(s, 80, 'high', true, ci.HARM_TO_OTHERS_GUIDANCE, 'harm_to_others');
    expect(injected()).toEqual([ci.HARM_TO_OTHERS_GUIDANCE]);
    expect(alone()).toHaveLength(1);
  });

  it('the medium and the high steer each carry it in one append: one instruction, nothing after it', async () => {
    // ai-therapist-381: the high steer used to be followed by the heads-up as a
    // second instruction within milliseconds, which can interrupt the reply
    // the first one started.
    expect(ci.fitsWithHeadsUp(ci.steeringGuidance(64, 'medium'))).toBe(true);
    // The first medium steer also carries the spoken crisis line, and the three still go as one.
    expect(ci.fitsWithHeadsUp(medium(64))).toBe(true);
    expect(ci.fitsWithHeadsUp(ci.steeringGuidance(100, 'high'))).toBe(true);
    const s = fresh();
    await ci.maybeSteerSession(s, 90, 'high');
    expect(injected()).toEqual([`${ci.steeringGuidance(90, 'high')} ${hu.VOICE_HEADS_UP_GUIDANCE}`]);
    expect(alone()).toHaveLength(0);
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      s,
      'risk_steering',
      expect.objectContaining({ severity: 'high', voiceHeadsUp: 'attached' }),
    );
  });

  it('not for a session the GPT-Live sideband cannot give it to (recovery session, other backend)', async () => {
    sidebandManagerMock.headsUpEligible.mockReturnValue(false);
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([medium(55)]);
  });

  it('a failure deciding never costs the steer', async () => {
    sidebandManagerMock.headsUpEligible.mockImplementation(() => {
      throw new Error('boom');
    });
    const s = fresh();
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(injected()).toEqual([medium(55)]);
    sidebandManagerMock.headsUpEligible.mockReturnValue(true);
  });

  it('a heads-up that could not be sent is not counted as requested', async () => {
    const s = fresh();
    await ci.maybeSteerSession(s, 30, 'low');
    sidebandManagerMock.tryInject.mockResolvedValueOnce(false);
    await ci.maybeSteerSession(s, 55, 'medium');
    expect(hu.voiceHeadsUpPending(s)).toBe(false);
  });

  it('no forbidden promise in any text the steer can now carry', () => {
    const texts = [`${medium(55)} ${hu.VOICE_HEADS_UP_GUIDANCE}`, hu.VOICE_HEADS_UP_STEER];
    for (const t of texts) {
      expect(t).not.toMatch(/help is on the way|someone is coming|will (contact|call) you|reach out to you/i);
    }
  });
});
