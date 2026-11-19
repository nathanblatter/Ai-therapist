import { describe, it, expect, vi } from 'vitest';
import {
  closeDisposition,
  crisisEmergencyMarksCrisis,
  eligibilityGoodbyeFinished,
  isModerationStop,
  nextRecoveryStep,
  recoveryScreenMayClose,
  startInterimSpeech,
  RECOVERY_FIRST_WORDS_WAIT_MS,
  ELIGIBILITY_GOODBYE_MAX_WAIT_MS,
  ELIGIBILITY_GOODBYE_MIN_WAIT_MS,
  ELIGIBILITY_GOODBYE_QUIET_MS,
  ELIGIBILITY_GOODBYE_START_WAIT_MS,
} from './crisisRecovery';

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

describe('nextRecoveryStep: the terminal ladder never ends on a dead screen', () => {
  const base = { voiceEnabled: true, chatEnabled: true, maxVoiceAttempts: 2 };

  it('voice first, and again after a second cut', () => {
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 0 })).toBe('voice');
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 1 })).toBe('voice');
  });

  it('typed chat once the voice attempts are spent', () => {
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 2 })).toBe('text');
    expect(nextRecoveryStep({ ...base, voiceAttemptsSpent: 5 })).toBe('text');
  });

  it('typed chat straight away when voice is disabled', () => {
    expect(nextRecoveryStep({ ...base, voiceEnabled: false, voiceAttemptsSpent: 0 })).toBe('text');
  });

  it('the crisis screen (which stays up) only when there is no typed chat to fall back to', () => {
    expect(nextRecoveryStep({ ...base, chatEnabled: false, voiceAttemptsSpent: 2 })).toBe('unavailable');
    expect(
      nextRecoveryStep({ voiceEnabled: false, chatEnabled: false, voiceAttemptsSpent: 0, maxVoiceAttempts: 2 }),
    ).toBe('unavailable');
    // Voice still comes first even then.
    expect(nextRecoveryStep({ ...base, chatEnabled: false, voiceAttemptsSpent: 1 })).toBe('voice');
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
