// The voice heads-up before a vendor cut: matcher, once-only latch, trigger
// conditions, off switch, and the wording (no false promise).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQueryMock, logInterventionActionMock, getSystemConfigMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  logInterventionActionMock: vi.fn(async () => undefined),
  getSystemConfigMock: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
}));

vi.mock('../config/db.js', () => ({ pool: { query: poolQueryMock } }));
vi.mock('./crisisDetection.service.js', () => ({ logInterventionAction: logInterventionActionMock }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
vi.mock('../db/index.js', () => ({
  getSessionAccessInfo: vi.fn(),
  getTherapistIdsForClient: vi.fn(async () => []),
  getCaseworkerIdsForClient: vi.fn(async () => []),
}));

const hu = await import('./voiceHeadsUp.service.js');

const ON = { features: { voice_heads_up_enabled: true, chat_enabled: true } };

/** Phrases that would promise the participant something that is not true. */
const FALSE_PROMISES = [
  'help is on the way',
  'on the way',
  'someone is coming',
  'is coming',
  'someone will',
  'will contact you',
  'will reach out',
  'will call you',
  'has been notified',
  'have been notified',
  'been alerted',
  'been contacted',
  'send someone',
  'sending someone',
  'a person will',
  'a counselor will',
  'the research team',
  'on-call',
];

beforeEach(() => {
  hu._resetVoiceHeadsUpForTests();
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [] });
  logInterventionActionMock.mockClear();
  getSystemConfigMock.mockReset();
  getSystemConfigMock.mockResolvedValue(ON);
});

describe('the wording', () => {
  it.each([
    ['guidance', hu.VOICE_HEADS_UP_GUIDANCE],
    ['standalone steer', hu.VOICE_HEADS_UP_STEER],
    ['example line', hu.VOICE_HEADS_UP_EXAMPLE],
  ])('the %s promises nothing about help, a person or contact', (_name, text) => {
    const lower = text.toLowerCase();
    for (const phrase of FALSE_PROMISES) expect(lower, phrase).not.toContain(phrase);
  });

  it('the standalone steer is a clinical steer (marker first) carrying the guidance', () => {
    expect(hu.VOICE_HEADS_UP_STEER.startsWith('[Clinical guidance')).toBe(true);
    expect(hu.VOICE_HEADS_UP_STEER).toContain(hu.VOICE_HEADS_UP_GUIDANCE);
  });

  it('the example line is recognised by the matcher, and is short', () => {
    expect(hu.headsUpSpokenIn(hu.VOICE_HEADS_UP_EXAMPLE)).toBe(true);
    expect(hu.VOICE_HEADS_UP_EXAMPLE.split(/\s+/).length).toBeLessThanOrEqual(20);
  });

  it('asks for it once, inside the reply, keeping the safety question', () => {
    expect(hu.VOICE_HEADS_UP_GUIDANCE).toMatch(/once only/);
    expect(hu.VOICE_HEADS_UP_GUIDANCE).toMatch(/question about their safety/);
    expect(hu.VOICE_HEADS_UP_GUIDANCE).toMatch(/not a warning or disclaimer/);
    expect(hu.VOICE_HEADS_UP_GUIDANCE).toMatch(/before you ask anything about their safety/);
  });
});

describe('headsUpSpokenIn', () => {
  it.each([
    "I'm right here with you. If the voice part of this drops, I'm not gone. I'll be right there in writing on your screen.",
    'And if our voice connection cuts out, I will still be here, and we can keep going in writing on your screen.',
    'If the call ends for any reason, we can carry on by typing in the chat on your screen.',
    'If the audio stops, I am not gone; we just continue in writing.',
    'If the voice part of this drops, I’m not gone. I’ll be right there in writing on your screen.',
    // Cut off before "in writing": the participant still heard it.
    "And if the voice part of this drops, I'm not gone. I'll be",
  ])('recognises: %s', (text) => {
    expect(hu.headsUpSpokenIn(text)).toBe(true);
  });

  it.each([
    "You can call or text 988 any time, and I've put those numbers on your screen. I'm still here.",
    "Have you tried writing things down before bed? I'm still here with you.",
    'If the voice part of this drops, just know I care.',
    'I hear you. That sounds so heavy. Are you having thoughts of suicide right now?',
    "Let's take a breath together. I'm right here.",
    "Feelings like this don't just drop away overnight. I'm here.",
  ])('does not count: %s', (text) => {
    expect(hu.headsUpSpokenIn(text)).toBe(false);
  });
});

describe('headsUpDueFor (trigger conditions and the latch, pure)', () => {
  const base = (over: Partial<import('./voiceHeadsUp.service.js').HeadsUpState> = {}) => ({
    requests: 1,
    lastRequestAt: 1_000,
    turnsSinceRequest: 0,
    spokenAt: 0,
    participantSpokeAt: 0,
    severity: 'medium',
    riskScore: 50,
    delivery: 'attached' as const,
    touchedAt: 1_000,
    ...over,
  });

  it('only medium and high turns', () => {
    for (const sev of ['none', 'low', 'unknown']) expect(hu.headsUpDueFor(undefined, sev, 0)).toBe(false);
    expect(hu.headsUpDueFor(undefined, 'medium', 0)).toBe(true);
    expect(hu.headsUpDueFor(undefined, 'high', 0)).toBe(true);
  });

  it('never again once spoken', () => {
    expect(hu.headsUpDueFor(base({ spokenAt: 2_000, turnsSinceRequest: 9 }), 'high', 999_999)).toBe(false);
  });

  it('not repeated while the request may still be on its way into the reply', () => {
    expect(hu.headsUpDueFor(base({ turnsSinceRequest: 1 }), 'high', 1_000 + hu.VOICE_HEADS_UP_MISSED_MS - 1)).toBe(
      false,
    );
  });

  it('repeated once it was missed (by turns or by time), up to the cap', () => {
    expect(hu.headsUpDueFor(base({ turnsSinceRequest: hu.VOICE_HEADS_UP_MISSED_TURNS }), 'high', 1_001)).toBe(true);
    expect(hu.headsUpDueFor(base(), 'medium', 1_000 + hu.VOICE_HEADS_UP_MISSED_MS)).toBe(true);
    expect(
      hu.headsUpDueFor(base({ requests: hu.VOICE_HEADS_UP_MAX_REQUESTS, turnsSinceRequest: 9 }), 'high', 999_999),
    ).toBe(false);
  });
});

describe('voiceHeadsUpEnabled (the off switch)', () => {
  it('is off when the key is absent (the migrated default)', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { chat_enabled: true } });
    expect(await hu.voiceHeadsUpEnabled()).toBe(false);
  });

  it('is off for anything but true', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { voice_heads_up_enabled: 'true' } });
    expect(await hu.voiceHeadsUpEnabled()).toBe(false);
  });

  it('is off where typed chat is switched off (there is no written continuation to describe)', async () => {
    getSystemConfigMock.mockResolvedValue({ features: { voice_heads_up_enabled: true, chat_enabled: false } });
    expect(await hu.voiceHeadsUpEnabled()).toBe(false);
  });

  it('is off when the config cannot be read', async () => {
    getSystemConfigMock.mockRejectedValue(new Error('db down'));
    expect(await hu.voiceHeadsUpEnabled()).toBe(false);
  });

  it('is on with the key true and typed chat on', async () => {
    expect(await hu.voiceHeadsUpEnabled()).toBe(true);
  });
});

describe('voiceHeadsUpDue and the once-only latch', () => {
  const S = 'live_test_session_1';
  const mark = () =>
    hu.markVoiceHeadsUpRequested(S, { severity: 'medium', riskScore: 50, participantSpokeAt: 0, delivery: 'attached' });

  it('is never due with the switch off, on a low turn, or for a session the sideband cannot steer', async () => {
    getSystemConfigMock.mockResolvedValue({ features: {} });
    expect(await hu.voiceHeadsUpDue(S, 'medium', true)).toBe(false);
    getSystemConfigMock.mockResolvedValue(ON);
    expect(await hu.voiceHeadsUpDue(S, 'low', true)).toBe(false);
    expect(await hu.voiceHeadsUpDue(S, 'high', false)).toBe(false);
  });

  it('is due at the first medium turn of a fresh session', async () => {
    expect(await hu.voiceHeadsUpDue(S, 'medium', true)).toBe(true);
  });

  it('sets the latch only when the line is heard, records it once, and never asks again', async () => {
    await hu.voiceHeadsUpDue(S, 'medium', true);
    mark();
    expect(hu.voiceHeadsUpPending(S)).toBe(true);
    // A partial turn without the line is not a finished turn.
    expect(hu.noteVoiceHeadsUpSpeech(S, 'I hear how heavy this is.', false)).toBe(false);
    expect(hu.voiceHeadsUpSpoken(S)).toBe(false);
    expect(hu.noteVoiceHeadsUpSpeech(S, `I hear you. ${hu.VOICE_HEADS_UP_EXAMPLE}`, false)).toBe(true);
    expect(hu.voiceHeadsUpSpoken(S)).toBe(true);
    // The same turn finishing, or a second saying, does not record again.
    expect(hu.noteVoiceHeadsUpSpeech(S, `I hear you. ${hu.VOICE_HEADS_UP_EXAMPLE}`, true)).toBe(false);
    await vi.waitFor(() => expect(logInterventionActionMock).toHaveBeenCalledTimes(1));
    expect(logInterventionActionMock).toHaveBeenCalledWith(
      S,
      'risk_steering',
      expect.objectContaining({ trigger: hu.HEADS_UP_TRIGGER_SPOKEN, request: 1, delivery: 'attached' }),
    );
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(false);
  });

  it('a request that was missed may be repeated once; never a third time', async () => {
    await hu.voiceHeadsUpDue(S, 'medium', true);
    mark();
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(false);
    for (let i = 0; i < hu.VOICE_HEADS_UP_MISSED_TURNS; i++)
      hu.noteVoiceHeadsUpSpeech(S, 'That sounds so heavy.', true);
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(true);
    mark();
    for (let i = 0; i < hu.VOICE_HEADS_UP_MISSED_TURNS; i++) hu.noteVoiceHeadsUpSpeech(S, 'I hear you.', true);
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(false);
  });

  it('survives a sideband reconnect: the state is per session, not per attach', async () => {
    await hu.voiceHeadsUpDue(S, 'medium', true);
    mark();
    hu.noteVoiceHeadsUpSpeech(S, hu.VOICE_HEADS_UP_EXAMPLE, true);
    // A reconnect builds fresh sideband state; nothing here is touched by it,
    // and the database is not consulted again.
    poolQueryMock.mockClear();
    expect(await hu.voiceHeadsUpDue(S, 'medium', true)).toBe(false);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('after a process restart, reads the record: spoken before means never again', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [
        { trigger: null, heads_up: 'attached' },
        { trigger: hu.HEADS_UP_TRIGGER_SPOKEN, heads_up: null },
      ],
    });
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(false);
  });

  it('after a process restart, the request cap counts the recorded requests', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [
        { trigger: null, heads_up: 'attached' },
        { trigger: hu.HEADS_UP_TRIGGER_REQUESTED, heads_up: null },
      ],
    });
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(false);
  });

  it('after a process restart, one unanswered request may still be repeated', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ trigger: null, heads_up: 'attached' }] });
    expect(await hu.voiceHeadsUpDue(S, 'high', true)).toBe(true);
  });

  it('an unreadable record fails toward not saying it (a repeat is worse than no line)', async () => {
    poolQueryMock.mockRejectedValue(new Error('pool timeout'));
    expect(await hu.voiceHeadsUpDue(S, 'medium', true)).toBe(false);
    // Not remembered as read: the next turn tries again.
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await hu.voiceHeadsUpDue(S, 'medium', true)).toBe(true);
  });

  it('clearVoiceHeadsUp forgets the session', async () => {
    await hu.voiceHeadsUpDue(S, 'medium', true);
    mark();
    hu.clearVoiceHeadsUp(S);
    expect(hu.voiceHeadsUpPending(S)).toBe(false);
  });
});
