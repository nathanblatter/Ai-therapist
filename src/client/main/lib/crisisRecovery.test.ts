import { describe, it, expect, vi } from 'vitest';
import {
  closeDisposition,
  crisisEmergencyMarksCrisis,
  eligibilityGoodbyeFinished,
  handoffReasonFromClose,
  isModerationStop,
  nextRecoveryStep,
  readHandoffStart,
  recoveryScreenMayClose,
  runVoiceReturn,
  startInterimSpeech,
  VOICE_RETURN_FAILED_NOTICE,
  VOICE_RETURN_REFUSED_NOTICE,
  RECOVERY_FIRST_WORDS_WAIT_MS,
  ELIGIBILITY_GOODBYE_MAX_WAIT_MS,
  ELIGIBILITY_GOODBYE_MIN_WAIT_MS,
  ELIGIBILITY_GOODBYE_QUIET_MS,
  ELIGIBILITY_GOODBYE_START_WAIT_MS,
} from './crisisRecovery';
import {
  HANDOFF_CEILING_FIRST_MESSAGE,
  HANDOFF_CHECKIN_FIRST_MESSAGE,
  HANDOFF_CRISIS_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE,
  HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE,
} from '../../../shared/textHandoff';

// The participant app's decisions around a vendor cut (ai-therapist-293) and an
// age-eligibility end (ai-therapist-296). App.tsx has no test harness of its
// own, so what it decides is tested here and what it renders is not.

describe('closeDisposition', () => {
  it('a content close is always recovered, with no server event and no risk flag needed', () => {
    expect(closeDisposition('content', false)).toBe('recover');
    expect(closeDisposition('content', true)).toBe('recover');
  });

  it('the vendor ceiling is recovered only on a session the server flagged high', () => {
    expect(closeDisposition('expired', true)).toBe('recover');
    expect(closeDisposition('expired', false)).toBe('normal');
  });

  it('every other close is an ordinary end', () => {
    for (const reason of ['close_requested', 'remote_hangup', 'connection_lost', undefined, null, 42]) {
      expect(closeDisposition(reason, true)).toBe('normal');
    }
  });
});

describe('isModerationStop', () => {
  it('recognises the content_filter error and nothing else', () => {
    expect(isModerationStop({ code: 'content_filter' })).toBe(true);
    expect(isModerationStop({ code: 'context_injection_incomplete' })).toBe(false);
    expect(isModerationStop({})).toBe(false);
    expect(isModerationStop(undefined)).toBe(false);
    expect(isModerationStop(null)).toBe(false);
  });
});

describe('crisisEmergencyMarksCrisis', () => {
  it('our own high flag marks the session', () => {
    expect(crisisEmergencyMarksCrisis({ severity: 'high' })).toBe(true);
  });

  it('a vendor stop or cut (severity null) opens the card but does not mark the session', () => {
    expect(crisisEmergencyMarksCrisis({ severity: null })).toBe(false);
  });

  it('an older server, which sent this event only for a high flag, still marks it', () => {
    expect(crisisEmergencyMarksCrisis(undefined)).toBe(true);
    expect(crisisEmergencyMarksCrisis({})).toBe(true);
  });
});

describe('nextRecoveryStep: a vendor cut goes straight to typed chat, and never ends on a dead screen', () => {
  const base = { voiceEnabled: true, chatEnabled: true, maxVoiceAttempts: 2 };

  it('typed chat first: no new voice session on the vendor that just ended the call', () => {
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 0 })).toBe('text');
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 1 })).toBe('text');
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 2 })).toBe('text');
  });

  it('typed chat when voice is disabled too', () => {
    expect(nextRecoveryStep({ ...base, voiceEnabled: false, voiceAttemptsSpent: 0 })).toBe('text');
  });

  it('a deployment with no typed chat keeps the recovery voice session, up to the cap', () => {
    expect(nextRecoveryStep({ ...base, chatEnabled: false, voiceAttemptsSpent: 0 })).toBe('voice');
    expect(nextRecoveryStep({ ...base, chatEnabled: false, voiceAttemptsSpent: 1 })).toBe('voice');
  });

  it('the crisis screen (which stays up) only when there is nothing left to continue in', () => {
    expect(nextRecoveryStep({ ...base, chatEnabled: false, voiceAttemptsSpent: 2 })).toBe('unavailable');
    expect(
      nextRecoveryStep({ voiceEnabled: false, chatEnabled: false, voiceAttemptsSpent: 0, maxVoiceAttempts: 2 }),
    ).toBe('unavailable');
  });
});

describe('handoffReasonFromClose', () => {
  it("names the vendor's session ceiling; everything else is its content filter", () => {
    expect(handoffReasonFromClose('expired')).toBe('expired');
    // session.closed says 'content'; the socket backstop says 'content_filter'.
    expect(handoffReasonFromClose('content')).toBe('content');
    expect(handoffReasonFromClose('content_filter')).toBe('content');
    expect(handoffReasonFromClose(undefined)).toBe('content');
    expect(handoffReasonFromClose(42)).toBe('content');
  });
});

describe('readHandoffStart: what the participant sees after the hand-off chat start', () => {
  const crisisBody = {
    sessionId: 'chat_1',
    opening: HANDOFF_CRISIS_FIRST_MESSAGE,
    handoff: {
      kind: 'crisis',
      severity: 'high',
      reason: 'content',
      quickReplies: ['Yes', 'No', 'Not sure'],
      voiceReturnAllowed: false,
      spokenBridge: 'spoken line from the server',
      seededFrom: ['live_A'],
    },
  };

  it('crisis cut: the chat, with the server-authored first message and the one-tap answers', () => {
    expect(readHandoffStart(200, crisisBody)).toEqual({
      screen: 'chat',
      sessionId: 'chat_1',
      firstMessage: HANDOFF_CRISIS_FIRST_MESSAGE,
      serverAuthored: true,
      handoff: {
        kind: 'crisis',
        quickReplies: ['Yes', 'No', 'Not sure'],
        voiceReturnAllowed: false,
        spokenBridge: 'spoken line from the server',
      },
      fallback: null,
    });
  });

  it('no-risk cut: the neutral message, no quick replies, the voice offer as the server gave it', () => {
    const outcome = readHandoffStart(200, {
      sessionId: 'chat_2',
      opening: HANDOFF_NEUTRAL_FIRST_MESSAGE,
      handoff: { kind: 'neutral', quickReplies: [], voiceReturnAllowed: true, spokenBridge: 'neutral line' },
    });
    expect(outcome).toMatchObject({
      screen: 'chat',
      firstMessage: HANDOFF_NEUTRAL_FIRST_MESSAGE,
      handoff: { kind: 'neutral', quickReplies: [], voiceReturnAllowed: true },
    });
    if (outcome.screen === 'chat') expect(outcome.firstMessage).not.toMatch(/ending your life/);
  });

  it('vendor ceiling: the chat, no quick replies', () => {
    const outcome = readHandoffStart(200, {
      sessionId: 'chat_3',
      opening: 'ceiling message',
      handoff: { kind: 'ceiling', quickReplies: [], voiceReturnAllowed: false },
    });
    expect(outcome).toMatchObject({ screen: 'chat', handoff: { kind: 'ceiling', quickReplies: [] } });
    // No spoken line from the server: the shared one for that kind is used.
    if (outcome.screen === 'chat') expect(outcome.handoff.spokenBridge).toMatch(/moved us to writing/);
  });

  it.each([
    ['a server error', 500, { error: 'Failed to start chat session' }],
    ['a rate limit', 429, { error: 'Session limit exceeded' }],
    ['no response at all (network failure or timeout)', 0, null],
    ['a session the server handed back instead of a new one', 200, { sessionId: 'other', alreadyActive: true }],
    ['a response with no session id', 200, { success: true }],
    ['an empty body', 200, null],
  ])('chat start failure (%s): the retry screen, never a blank one', (_name, status, body) => {
    const outcome = readHandoffStart(status, body);
    expect(outcome.screen).toBe('failed');
    if (outcome.screen === 'failed') expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it('says why there was no response', () => {
    expect(readHandoffStart(0, null, 'The operation was aborted')).toEqual({
      screen: 'failed',
      reason: 'no response: The operation was aborted',
    });
  });

  // PR #77 review, item 3: no client failure path may choose calm wording. The
  // browser knows the vendor cut the call; without the server's reading the
  // risk is unknown, and unknown is a crisis.
  const cut = { voiceSessionId: 'live_A', reason: 'content' as const };

  it('a chat session with no hand-off from the server: crisis wording, pinned card, quick replies, and the server is told', () => {
    const outcome = readHandoffStart(200, { sessionId: 'chat_4', opening: null, handoff: null }, undefined, cut);
    expect(outcome).toEqual({
      screen: 'chat',
      sessionId: 'chat_4',
      firstMessage: HANDOFF_CRISIS_FIRST_MESSAGE,
      serverAuthored: false,
      handoff: {
        kind: 'crisis',
        quickReplies: ['Yes', 'No', 'Not sure'],
        voiceReturnAllowed: false,
        spokenBridge: expect.stringMatching(/call or text 988/),
      },
      fallback: { continued_from: 'live_A', reason: 'content' },
    });
    if (outcome.screen === 'chat') {
      expect(outcome.firstMessage).not.toBe(HANDOFF_NEUTRAL_FIRST_MESSAGE_NO_VOICE);
      expect(outcome.firstMessage).not.toMatch(/ended unexpectedly/);
    }
  });

  it('the same after the vendor time limit, in the time-limit wording', () => {
    const outcome = readHandoffStart(200, { sessionId: 'chat_5', opening: 'x' }, undefined, {
      voiceSessionId: 'live_B',
      reason: 'expired',
    });
    expect(outcome).toMatchObject({
      screen: 'chat',
      firstMessage: HANDOFF_CEILING_FIRST_MESSAGE,
      handoff: { kind: 'ceiling', quickReplies: [], voiceReturnAllowed: false },
      fallback: { continued_from: 'live_B', reason: 'expired' },
    });
  });

  it('a server hand-off needs no fallback', () => {
    const outcome = readHandoffStart(200, crisisBody, undefined, cut);
    expect(outcome).toMatchObject({ serverAuthored: true, fallback: null });
  });

  it('reads the check-in kind', () => {
    const outcome = readHandoffStart(200, {
      sessionId: 'chat_6',
      opening: HANDOFF_CHECKIN_FIRST_MESSAGE,
      handoff: { kind: 'checkin', quickReplies: [], voiceReturnAllowed: false },
    });
    expect(outcome).toMatchObject({ screen: 'chat', serverAuthored: true, handoff: { kind: 'checkin' } });
  });

  it('ignores a hand-off kind it does not know (unknown risk, crisis wording), and junk quick replies', () => {
    expect(
      readHandoffStart(200, { sessionId: 'c', opening: 'x', handoff: { kind: 'party' } }, undefined, cut),
    ).toMatchObject({
      screen: 'chat',
      serverAuthored: false,
      handoff: { kind: 'crisis' },
      fallback: { continued_from: 'live_A' },
    });
    const outcome = readHandoffStart(200, {
      sessionId: 'c',
      opening: 'x',
      handoff: { kind: 'crisis', quickReplies: ['Yes', 7, '', '  ', 'No'] },
    });
    if (outcome.screen === 'chat') expect(outcome.handoff.quickReplies).toEqual(['Yes', 'No']);
  });
});

// PR #77 review, item 6: start the voice call first, end the chat only once it
// is established; a failure leaves the participant in the chat.
describe('runVoiceReturn', () => {
  function steps(over: Partial<Parameters<typeof runVoiceReturn>[0]> = {}) {
    const order: string[] = [];
    const s = {
      checkAllowed: vi.fn(async () => (order.push('check'), true)),
      startVoice: vi.fn(async () => (order.push('start'), true)),
      abandonVoice: vi.fn(() => void order.push('abandon')),
      endChat: vi.fn(async () => void order.push('endChat')),
      ...over,
    };
    return { s, order };
  }

  it('established: the voice call starts BEFORE the chat is ended', async () => {
    const { s, order } = steps();
    expect(await runVoiceReturn(s)).toBe('started');
    expect(order).toEqual(['check', 'start', 'endChat']);
    expect(s.abandonVoice).not.toHaveBeenCalled();
  });

  it.each([
    ['the start resolves false (refusal, no session.started)', async () => false],
    [
      'the start throws (microphone refused)',
      async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    ],
  ])('failure (%s): the chat is never ended, the half-started call is released', async (_name, startVoice) => {
    const { s } = steps({ startVoice: vi.fn(startVoice) });
    expect(await runVoiceReturn(s)).toBe('failed');
    expect(s.endChat).not.toHaveBeenCalled();
    expect(s.abandonVoice).toHaveBeenCalledTimes(1);
  });

  it('refused by the server (risk not cleared, quiet hours) or the check failing: nothing is started or ended', async () => {
    for (const checkAllowed of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error('offline');
      }),
    ]) {
      const { s } = steps({ checkAllowed });
      expect(await runVoiceReturn(s)).toBe('refused');
      expect(s.startVoice).not.toHaveBeenCalled();
      expect(s.endChat).not.toHaveBeenCalled();
    }
  });

  it('a chat end that fails does not undo a call that is up', async () => {
    const { s } = steps({
      endChat: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    expect(await runVoiceReturn(s)).toBe('started');
  });

  it('the participant-facing lines are plain and offer the chat', () => {
    expect(VOICE_RETURN_FAILED_NOTICE).toBe(
      "The voice call couldn't be started. We can keep going right here in writing.",
    );
    expect(VOICE_RETURN_REFUSED_NOTICE).toMatch(/keep going right here in writing/);
  });
});

describe('recoveryScreenMayClose: the screen stays until the assistant is actually back', () => {
  const sessionStartedAt = 50_000;

  it('does not close at session.started, when the call exists but nobody has spoken (the old behaviour)', () => {
    expect(recoveryScreenMayClose({ now: sessionStartedAt, sessionStartedAt, lastAssistantSpeechAt: null })).toBe(
      false,
    );
    expect(
      recoveryScreenMayClose({ now: sessionStartedAt + 5_000, sessionStartedAt, lastAssistantSpeechAt: null }),
    ).toBe(false);
  });

  it("closes on the returning assistant's first words", () => {
    expect(
      recoveryScreenMayClose({
        now: sessionStartedAt + 1_900,
        sessionStartedAt,
        lastAssistantSpeechAt: sessionStartedAt + 1_850,
      }),
    ).toBe(true);
  });

  it("is not fooled by the terminated session's last words", () => {
    expect(
      recoveryScreenMayClose({
        now: sessionStartedAt + 1_000,
        sessionStartedAt,
        lastAssistantSpeechAt: sessionStartedAt - 3_000,
      }),
    ).toBe(false);
  });

  it('closes anyway once the wait runs out, so a silent session cannot hold the screen forever', () => {
    expect(
      recoveryScreenMayClose({
        now: sessionStartedAt + RECOVERY_FIRST_WORDS_WAIT_MS - 1,
        sessionStartedAt,
        lastAssistantSpeechAt: null,
      }),
    ).toBe(false);
    expect(
      recoveryScreenMayClose({
        now: sessionStartedAt + RECOVERY_FIRST_WORDS_WAIT_MS,
        sessionStartedAt,
        lastAssistantSpeechAt: null,
      }),
    ).toBe(true);
  });
});

describe('startInterimSpeech', () => {
  function env() {
    const synth = { speak: vi.fn(), cancel: vi.fn() };
    const utterances: Array<{ text: string; lang?: string; rate?: number; volume?: number }> = [];
    const makeUtterance = (text: string) => {
      const u = { text };
      utterances.push(u);
      return u;
    };
    return { synth, makeUtterance, utterances };
  }

  it('speaks the line at once, in English, clearing anything queued first', () => {
    const e = env();
    startInterimSpeech(e, 'The call was cut off.', 'en');
    expect(e.synth.cancel).toHaveBeenCalledTimes(1);
    expect(e.synth.speak).toHaveBeenCalledTimes(1);
    expect(e.utterances[0]).toMatchObject({ text: 'The call was cut off.', lang: 'en-US', rate: 1, volume: 1 });
    expect(e.synth.cancel.mock.invocationCallOrder[0]).toBeLessThan(e.synth.speak.mock.invocationCallOrder[0]);
  });

  it('returns a stop function that cancels the speech once and only once', () => {
    const e = env();
    const stop = startInterimSpeech(e, 'The call was cut off.', 'en-GB');
    e.synth.cancel.mockClear();
    stop();
    stop();
    expect(e.synth.cancel).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a non-English session rather than reading English in another voice', () => {
    const e = env();
    const stop = startInterimSpeech(e, 'The call was cut off.', 'es');
    expect(e.synth.speak).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('is a safe no-op when the browser has no speech synthesis', () => {
    expect(() => startInterimSpeech({}, 'The call was cut off.', 'en')()).not.toThrow();
    expect(() => startInterimSpeech({ synth: null, makeUtterance: null }, 'x', 'en')()).not.toThrow();
  });

  it('never throws when the speech engine does (recovery must go on)', () => {
    const synth = {
      speak: vi.fn(() => {
        throw new Error('not allowed');
      }),
      cancel: vi.fn(),
    };
    expect(() => startInterimSpeech({ synth, makeUtterance: (text) => ({ text }) }, 'x', 'en')()).not.toThrow();

    const cancelThrows = {
      speak: vi.fn(),
      cancel: vi
        .fn()
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw new Error('cannot cancel');
        }),
    };
    const stop = startInterimSpeech({ synth: cancelThrows, makeUtterance: (text) => ({ text }) }, 'x', 'en');
    expect(() => stop()).not.toThrow();
  });

  it('says nothing for an empty line', () => {
    const e = env();
    startInterimSpeech(e, '   ', 'en');
    expect(e.synth.speak).not.toHaveBeenCalled();
  });
});

describe('eligibilityGoodbyeFinished: the goodbye is heard before the call ends', () => {
  const signalledAt = 100_000;

  it('does not hang up in the same instant the server signals the end (the old behaviour)', () => {
    expect(eligibilityGoodbyeFinished({ now: signalledAt, signalledAt, lastAssistantSpeechAt: null })).toBe(false);
    expect(eligibilityGoodbyeFinished({ now: signalledAt + 1_000, signalledAt, lastAssistantSpeechAt: null })).toBe(
      false,
    );
  });

  it('is not fooled by the tail of the reply that was in progress when the signal arrived', () => {
    // A fragment 200 ms after the signal, then quiet for longer than the quiet
    // gap, but the goodbye has not had time to start yet.
    const lastAssistantSpeechAt = signalledAt + 200;
    const now = lastAssistantSpeechAt + ELIGIBILITY_GOODBYE_QUIET_MS + 100;
    expect(now - signalledAt).toBeLessThan(ELIGIBILITY_GOODBYE_MIN_WAIT_MS);
    expect(eligibilityGoodbyeFinished({ now, signalledAt, lastAssistantSpeechAt })).toBe(false);
  });

  it('waits while the goodbye is still being spoken', () => {
    const now = signalledAt + 12_000;
    expect(eligibilityGoodbyeFinished({ now, signalledAt, lastAssistantSpeechAt: now - 300 })).toBe(false);
  });

  it('finishes once the goodbye has been quiet for the quiet gap', () => {
    const lastAssistantSpeechAt = signalledAt + 11_000;
    expect(
      eligibilityGoodbyeFinished({
        now: lastAssistantSpeechAt + ELIGIBILITY_GOODBYE_QUIET_MS,
        signalledAt,
        lastAssistantSpeechAt,
      }),
    ).toBe(true);
  });

  it('gives up waiting when the assistant never starts the goodbye', () => {
    const before = signalledAt - 5_000; // only spoke before the signal
    expect(
      eligibilityGoodbyeFinished({
        now: signalledAt + ELIGIBILITY_GOODBYE_START_WAIT_MS - 1,
        signalledAt,
        lastAssistantSpeechAt: before,
      }),
    ).toBe(false);
    expect(
      eligibilityGoodbyeFinished({
        now: signalledAt + ELIGIBILITY_GOODBYE_START_WAIT_MS,
        signalledAt,
        lastAssistantSpeechAt: before,
      }),
    ).toBe(true);
    expect(
      eligibilityGoodbyeFinished({
        now: signalledAt + ELIGIBILITY_GOODBYE_START_WAIT_MS,
        signalledAt,
        lastAssistantSpeechAt: null,
      }),
    ).toBe(true);
  });

  it('always ends by the hard cap, even if the assistant is still talking', () => {
    const now = signalledAt + ELIGIBILITY_GOODBYE_MAX_WAIT_MS;
    expect(eligibilityGoodbyeFinished({ now, signalledAt, lastAssistantSpeechAt: now - 10 })).toBe(true);
  });
});
