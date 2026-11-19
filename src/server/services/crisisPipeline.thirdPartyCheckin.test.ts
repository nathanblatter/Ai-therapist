// Two pipeline behaviours added after the first goldens baseline (2026-11-18):
//
//  1. A third party at risk (ai-therapist-326). The flag and the page are the
//     same as for the participant's own crisis; what differs is that every
//     record a person reads says who is at risk, the model is steered to help
//     the participant respond, and the suicide ladder is not demanded.
//  2. The pre-session check-in goes through this pipeline as a first message
//     does, and stays visible to the assessor on the turns that follow.
//
// Collaborators are mocked, as in crisisPipeline.service.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  analyzeMessageRiskMock,
  flagSessionCrisisMock,
  logInterventionActionMock,
  maybeSteerSessionMock,
  shouldSteerMock,
  maybeRequireRiskCheckMock,
  executeGraduatedResponseMock,
  getRecentSessionMessagesMock,
  getSessionCrisisStateMock,
  getSessionCheckinMock,
  enqueueWorkItemMock,
  emitCrisisResourcesMock,
} = vi.hoisted(() => ({
  emitCrisisResourcesMock: vi.fn(),
  analyzeMessageRiskMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
  maybeSteerSessionMock: vi.fn(),
  shouldSteerMock: vi.fn(),
  maybeRequireRiskCheckMock: vi.fn(),
  executeGraduatedResponseMock: vi.fn(),
  getRecentSessionMessagesMock: vi.fn(),
  getSessionCrisisStateMock: vi.fn(),
  getSessionCheckinMock: vi.fn(),
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
  buildChatSteeringGuidance: (s: number) => `CHAT_STEER_${s}`,
  maybeRequireRiskCheck: maybeRequireRiskCheckMock,
  executeGraduatedResponse: executeGraduatedResponseMock,
  CHAT_SAFETY_PROTOCOL_GUIDANCE: 'CHAT_HIGH_GUIDANCE',
  subjectGuidance: (subject: string | null, channel: string) =>
    subject === 'third_party'
      ? channel === 'chat'
        ? 'CHAT_THIRD_PARTY_GUIDANCE'
        : 'RT_THIRD_PARTY_GUIDANCE'
      : subject === 'harm_to_others'
        ? 'HARM_TO_OTHERS_GUIDANCE'
        : null,
  subjectLabel: (subject: string | null) =>
    subject === 'third_party'
      ? 'THIRD PARTY AT RISK: label'
      : subject === 'harm_to_others'
        ? 'RISK TO OTHERS: label'
        : null,
}));
vi.mock('./crisisResources.js', () => ({
  emitCrisisResources: emitCrisisResourcesMock,
  hasEmittedHighRiskResources: () => false,
}));
vi.mock('../db/index.js', () => ({
  getRecentSessionMessages: getRecentSessionMessagesMock,
  getSessionCrisisState: getSessionCrisisStateMock,
  getSessionCheckin: getSessionCheckinMock,
  isDemoAccountSession: vi.fn(async () => false),
  getSessionAccessInfo: vi.fn(async () => ({ status: 'active', user_id: 42, session_type: 'chat' })),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));
vi.mock('./workQueue.service.js', () => ({ enqueueWorkItem: enqueueWorkItemMock }));

const { runCrisisPipeline, runCheckinCrisisScreen, checkinFreeText, CHECKIN_FACTOR } = await import(
  './crisisPipeline.service.js'
);

const emitMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: emitMock })) };
  getRecentSessionMessagesMock.mockResolvedValue([]);
  getSessionCheckinMock.mockResolvedValue(null);
  getSessionCrisisStateMock.mockResolvedValue({
    crisis_flagged: false,
    crisis_severity: null,
    crisis_risk_score: null,
  });
  enqueueWorkItemMock.mockResolvedValue(null);
  shouldSteerMock.mockReturnValue(true);
  maybeRequireRiskCheckMock.mockResolvedValue('LADDER_REQUIRED');
});

const TURN = { sessionId: 'chat_1', messageId: 42, content: 'my roommate says she is going to kill herself tonight' };
const THIRD_FACTOR = 'third party at risk (reported by participant)';

function risk(riskScore: number, severity: string, extra: Record<string, unknown> = {}) {
  analyzeMessageRiskMock.mockResolvedValue({
    riskScore,
    severity,
    factors: ['stated intent'],
    breakdown: {},
    ...extra,
  });
}
const thirdPartyHigh = () => risk(90, 'high', { thirdParty: true, factors: [THIRD_FACTOR, 'stated intent'] });
const interventions = (type: string) =>
  logInterventionActionMock.mock.calls.filter((c) => c[1] === type).map((c) => c[2] as Record<string, unknown>);

describe('third party at risk: same flag and page, labelled', () => {
  it('flags high and runs the high-risk response, telling it the subject is a third party', async () => {
    thirdPartyHigh();

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(r.flagged).toBe(true);
    expect(r.severity).toBe('high');
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90, { thirdParty: true });
  });

  it('the crisis event says who is at risk: first factor and the notes', async () => {
    thirdPartyHigh();
    await runCrisisPipeline(TURN, 'chat');

    const [, , , , , , factors, notes] = flagSessionCrisisMock.mock.calls[0];
    expect(factors[0]).toBe(THIRD_FACTOR);
    expect(notes).toContain('THIRD PARTY AT RISK');
    expect(interventions('auto_flag')[0]).toMatchObject({ subject: 'third_party' });
  });

  it('the dashboard alert and the work item say so too', async () => {
    thirdPartyHigh();
    await runCrisisPipeline(TURN, 'chat');

    const detected = emitMock.mock.calls.find((c) => c[0] === 'session:crisis-detected');
    expect(detected![1]).toMatchObject({ subject: 'third_party' });
    expect(detected![1].message).toContain('THIRD PARTY AT RISK');
    expect(enqueueWorkItemMock.mock.calls[0][0].title).toContain('third party at risk');
  });

  it('chat: steers the reply toward helping the participant respond, not the suicide ladder', async () => {
    thirdPartyHigh();

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(r.steeringGuidance).toBe('CHAT_THIRD_PARTY_GUIDANCE');
    expect(maybeRequireRiskCheckMock).not.toHaveBeenCalled();
    expect(interventions('risk_steering')[0]).toMatchObject({ subject: 'third_party', channel: 'chat' });
    expect(interventions('safety_protocol')[0]).toMatchObject({ subject: 'third_party' });
  });

  it('realtime: the sideband steer carries the third-party guidance, forced past the cooldown', async () => {
    thirdPartyHigh();
    await runCrisisPipeline(TURN, 'realtime');
    expect(maybeSteerSessionMock).toHaveBeenCalledWith(
      'chat_1',
      90,
      'high',
      true,
      'RT_THIRD_PARTY_GUIDANCE',
      'third_party',
    );
    expect(maybeRequireRiskCheckMock).not.toHaveBeenCalled();
  });

  it('medium (nothing imminent): flagged and labelled, no high-risk response beyond the usual call', async () => {
    risk(55, 'medium', { thirdParty: true, factors: [THIRD_FACTOR] });

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(r.flagged).toBe(true);
    expect(r.steeringGuidance).toBe('CHAT_THIRD_PARTY_GUIDANCE');
    // executeGraduatedResponse only acts on 'high'; medium never pages.
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'medium', 55, { thirdParty: true });
  });

  it("the participant's own crisis is untouched: standard protocol, ladder, unlabelled records", async () => {
    risk(90, 'high');

    const r = await runCrisisPipeline(TURN, 'chat');

    expect(r.steeringGuidance).toBe('CHAT_HIGH_GUIDANCE\n\nLADDER_REQUIRED');
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90);
    const [, , , , , , factors, notes] = flagSessionCrisisMock.mock.calls[0];
    expect(factors).toEqual(['stated intent']);
    expect(notes).toBe('Risk score: 90 - Factors: stated intent');
    expect(interventions('auto_flag')[0]).not.toHaveProperty('subject');
    const detected = emitMock.mock.calls.find((c) => c[0] === 'session:crisis-detected');
    expect(detected![1]).not.toHaveProperty('subject');
    expect(detected![1].message).toBe('HIGH risk detected (score: 90)');
  });
});

describe('the pre-session check-in goes through the pipeline', () => {
  const CHECKIN = { mood: 1, topic: "I don't really want to be alive" };

  it('checkinFreeText is the two text fields, never the mood number', () => {
    expect(checkinFreeText({ topic: ' a ', goal: 'b' })).toBe('a\nb');
    expect(checkinFreeText({ goal: 'only a goal' })).toBe('only a goal');
    expect(checkinFreeText({ topic: '   ' })).toBe('');
    expect(checkinFreeText(null)).toBe('');
    expect(checkinFreeText({ mood: 1 } as never)).toBe('');
  });

  it('scores the text as a turn with no message id, marked as the check-in', async () => {
    risk(55, 'medium');

    await runCheckinCrisisScreen('chat_1', CHECKIN, 'chat');

    expect(analyzeMessageRiskMock).toHaveBeenCalledTimes(1);
    const [message] = analyzeMessageRiskMock.mock.calls[0];
    expect(message).toMatchObject({
      content: "I don't really want to be alive",
      session_id: 'chat_1',
      source: 'checkin',
    });
    expect(message.message_id).toBeUndefined();
  });

  it('same flag behaviour as a first message: medium flags, and the record says it came from the check-in', async () => {
    risk(55, 'medium');

    const r = await runCheckinCrisisScreen('chat_1', CHECKIN, 'chat');

    expect(r.flagged).toBe(true);
    expect(r.steeringGuidance).toContain('CHAT_STEER_55');
    const [, severity, score, , , messageId, factors, notes] = flagSessionCrisisMock.mock.calls[0];
    expect([severity, score, messageId]).toEqual(['medium', 55, null]);
    expect(factors).toContain(CHECKIN_FACTOR);
    expect(notes).toContain('Source: pre-session check-in text');
    expect(interventions('auto_flag')[0]).toMatchObject({ source: 'checkin' });
  });

  it('same page behaviour: a high check-in runs the high-risk response', async () => {
    risk(90, 'high');
    const r = await runCheckinCrisisScreen('chat_1', { topic: 'I am going to kill myself tonight' }, 'realtime');
    expect(r.severity).toBe('high');
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 90);
    expect(maybeSteerSessionMock).toHaveBeenCalledWith('chat_1', 90, 'high', true);
  });

  it('a check-in with no text (mood only, or none) scores nothing and makes no call', async () => {
    expect((await runCheckinCrisisScreen('chat_1', { mood: 2 } as never, 'chat')).riskScore).toBe(0);
    expect((await runCheckinCrisisScreen('chat_1', null, 'chat')).riskScore).toBe(0);
    expect(analyzeMessageRiskMock).not.toHaveBeenCalled();
  });

  it('an ordinary check-in does nothing', async () => {
    risk(0, 'none');
    const r = await runCheckinCrisisScreen('chat_1', { topic: 'midterms', goal: 'a study plan' }, 'chat');
    expect(r).toMatchObject({ riskScore: 0, flagged: false, steeringGuidance: null });
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
  });

  it('later turns show the assessor the check-in as the first thing the participant said', async () => {
    getSessionCheckinMock.mockResolvedValue(CHECKIN);
    getRecentSessionMessagesMock.mockResolvedValue([
      { role: 'assistant', content: 'Hi, I am an AI.', message_id: 1 },
      { role: 'user', content: 'hi', message_id: 2 },
    ]);
    risk(0, 'none');

    await runCrisisPipeline({ sessionId: 'chat_1', messageId: 2, content: 'hi' }, 'chat');

    const [, history] = analyzeMessageRiskMock.mock.calls[0];
    expect(history[0]).toEqual({
      role: 'user',
      content: "[Written in the pre-session check-in form] I don't really want to be alive",
    });
    expect(history).toHaveLength(3);
  });

  it('once the start of the session has left the window the check-in is no longer prepended', async () => {
    getSessionCheckinMock.mockResolvedValue(CHECKIN);
    getRecentSessionMessagesMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `t${i}`, message_id: i })),
    );
    risk(0, 'none');

    await runCrisisPipeline({ sessionId: 'chat_1', messageId: 9, content: 't9' }, 'chat');

    expect(analyzeMessageRiskMock.mock.calls[0][1]).toHaveLength(10);
    expect(getSessionCheckinMock).not.toHaveBeenCalled();
  });

  it('a failed check-in read never costs the turn its scoring', async () => {
    getSessionCheckinMock.mockRejectedValue(new Error('db down'));
    risk(55, 'medium');
    const r = await runCrisisPipeline({ sessionId: 'chat_1', messageId: 2, content: 'x' }, 'chat');
    expect(r.flagged).toBe(true);
  });
});

// Owner decision 2026-11-18 (ai-therapist-330): "bring them down from the
// ledge and notify staff".
describe('risk to others: flagged and paged like a high self-risk, labelled, de-escalation steer', () => {
  const HARM_TURN = {
    sessionId: 'chat_1',
    messageId: 43,
    content: 'I keep picturing hurting him. I know where he parks.',
  };
  const HARM_FACTOR = 'risk to others (thoughts of harming another person)';
  const harmHigh = () => risk(80, 'high', { subject: 'harm_to_others', factors: [HARM_FACTOR, 'intent'] });

  it('flags high and runs the high-risk response with the subject', async () => {
    harmHigh();
    const r = await runCrisisPipeline(HARM_TURN, 'chat');
    expect(r.flagged).toBe(true);
    expect(executeGraduatedResponseMock).toHaveBeenCalledWith('chat_1', 'high', 80, { subject: 'harm_to_others' });
  });

  it('every record a person reads says risk to others', async () => {
    harmHigh();
    await runCrisisPipeline(HARM_TURN, 'chat');

    const [, , , , , , factors, notes] = flagSessionCrisisMock.mock.calls[0];
    expect(factors[0]).toBe(HARM_FACTOR);
    expect(notes).toContain('RISK TO OTHERS');
    expect(interventions('auto_flag')[0]).toMatchObject({ subject: 'harm_to_others' });
    const detected = emitMock.mock.calls.find((c) => c[0] === 'session:crisis-detected');
    expect(detected![1]).toMatchObject({ subject: 'harm_to_others' });
    expect(detected![1].message).toContain('RISK TO OTHERS');
    expect(enqueueWorkItemMock.mock.calls[0][0].title).toContain('risk to others');
  });

  it('chat: the reply gets the de-escalation steer, not the suicide protocol or the ladder', async () => {
    harmHigh();
    const r = await runCrisisPipeline(HARM_TURN, 'chat');
    expect(r.steeringGuidance).toBe('HARM_TO_OTHERS_GUIDANCE');
    expect(maybeRequireRiskCheckMock).not.toHaveBeenCalled();
    expect(interventions('risk_steering')[0]).toMatchObject({ subject: 'harm_to_others' });
  });

  it('realtime: the sideband steer is the de-escalation text, forced past the cooldown', async () => {
    harmHigh();
    await runCrisisPipeline(HARM_TURN, 'realtime');
    expect(maybeSteerSessionMock).toHaveBeenCalledWith(
      'chat_1',
      80,
      'high',
      true,
      'HARM_TO_OTHERS_GUIDANCE',
      'harm_to_others',
    );
  });

  it('the suicide and crisis resource card is not pushed for risk to others; it still is for self-risk', async () => {
    harmHigh();
    await runCrisisPipeline(HARM_TURN, 'realtime');
    expect(emitCrisisResourcesMock).not.toHaveBeenCalled();

    risk(90, 'high');
    await runCrisisPipeline(TURN, 'realtime');
    expect(emitCrisisResourcesMock).toHaveBeenCalledTimes(1);
  });

  it('an idiom the assessor cleared does nothing at all', async () => {
    risk(5, 'none');
    const r = await runCrisisPipeline(
      { sessionId: 'chat_1', messageId: 44, content: "I swear I'm going to kill my lab partner" },
      'chat',
    );
    expect(r.flagged).toBe(false);
    expect(flagSessionCrisisMock).not.toHaveBeenCalled();
    expect(executeGraduatedResponseMock).not.toHaveBeenCalled();
    expect(maybeSteerSessionMock).not.toHaveBeenCalled();
    expect(emitCrisisResourcesMock).not.toHaveBeenCalled();
  });
});
