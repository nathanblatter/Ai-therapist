// Decisions the participant app makes around a vendor cut of a GPT-Live voice
// session (ai-therapist-293) and around an age-eligibility end
// (ai-therapist-296), kept out of App.tsx so they can be unit-tested: the
// component itself has no test harness, and these are the choices that decide
// what a participant in crisis sees and hears.
//
// Nothing here touches the DOM, React state or the network. App.tsx reads the
// answers and acts on them.

/** `error.code` the Live API sends when its moderation stops a generation. */
export const LIVE_CONTENT_FILTER_CODE = 'content_filter';

/**
 * What a `session.closed` on the data channel means for the participant.
 *
 * - `recover`: the vendor ended the call (its content filter, or its session
 *   ceiling while the server has this session flagged high). Crisis resources
 *   go up at once and the assistant is brought back; never the post-session
 *   screen. This does not wait for, or depend on, any server event.
 * - `normal`: an ordinary end.
 */
export function closeDisposition(reason: unknown, crisisActive: boolean): 'recover' | 'normal' {
  if (reason === 'content') return 'recover';
  if (reason === 'expired' && crisisActive) return 'recover';
  return 'normal';
}

/** True for the Live API `error` that means moderation stopped the assistant
 *  mid-reply. The session may or may not close right after; either way the
 *  participant just heard a reply stop partway, so crisis resources go up. */
export function isModerationStop(error: { code?: unknown } | null | undefined): boolean {
  return error?.code === LIVE_CONTENT_FILTER_CODE;
}

/**
 * Does a `session:crisis-emergency` event mark this session as in crisis (which
 * is what makes the vendor's session ceiling a cut to recover from)?
 *
 * Every such event opens the resource card. Only our own high flag marks the
 * session: the server also sends the event when the vendor stops a reply, and
 * that alone says nothing about risk. A payload with no severity is an older
 * server, which only ever sent this event for a high flag.
 */
export function crisisEmergencyMarksCrisis(payload: { severity?: unknown } | null | undefined): boolean {
  if (payload == null || payload.severity === undefined) return true;
  return payload.severity === 'high';
}

export type RecoveryStep =
  /** Bring the voice agent back on a recovery session. */
  | 'voice'
  /** Voice is spent or unavailable: continue the same conversation in typed chat. */
  | 'text'
  /** Nothing left to continue in: the crisis screen stays up with the numbers. */
  | 'unavailable';

/**
 * Where a cut conversation goes next.
 *
 * This is the whole terminal ladder, and it has no rung that ends on a dead
 * screen: voice up to the cap, then typed chat, then (only when this
 * deployment has no typed chat) the crisis screen with 988, the text line and
 * 911, which stays up. A failed chat start lands on the same screen with a
 * retry button (the 'failed' stage in App.tsx).
 */
export function nextRecoveryStep(input: {
  voiceEnabled: boolean;
  chatEnabled: boolean;
  voiceAttemptsSpent: number;
  maxVoiceAttempts: number;
}): RecoveryStep {
  if (input.voiceEnabled && input.voiceAttemptsSpent < input.maxVoiceAttempts) return 'voice';
  if (input.chatEnabled) return 'text';
  return 'unavailable';
}

/** How long the recovery screen stays up waiting for the returning assistant's
 *  first words before it comes down anyway. A healthy recovery session speaks
 *  1.5 to 2.9 s after it starts; the server re-sends the speak-first
 *  instruction at 4 s and 8 s if it has not (sidebandManager). */
export const RECOVERY_FIRST_WORDS_WAIT_MS = 12_000;

/**
 * May the recovery screen ("I'm coming right back", with the crisis lines)
 * come down yet?
 *
 * It used to come down at `session.started`, which is when the new call
 * exists, not when the assistant is back: a recovery session can sit silent
 * for many seconds after it starts (measured: 28 s once, and never within 90 s
 * once), and the participant was left looking at an ordinary call screen with
 * nobody talking. Now it stays until the assistant's first words arrive, or
 * RECOVERY_FIRST_WORDS_WAIT_MS has passed (the resource card stays on screen
 * after that either way).
 *
 * `lastAssistantSpeechAt` is the arrival time of the newest assistant
 * transcript fragment of the RECOVERY session, or null if there is none yet.
 */
export function recoveryScreenMayClose(input: {
  now: number;
  sessionStartedAt: number;
  lastAssistantSpeechAt: number | null;
}): boolean {
  if (input.lastAssistantSpeechAt != null && input.lastAssistantSpeechAt >= input.sessionStartedAt) return true;
  return input.now - input.sessionStartedAt >= RECOVERY_FIRST_WORDS_WAIT_MS;
}

// ---------------------------------------------------------------------------
// Interim spoken line
// ---------------------------------------------------------------------------

/** The slice of the Web Speech API this module needs. */
export interface SpeechSynthesisLike {
  speak(utterance: unknown): void;
  cancel(): void;
}

export interface InterimSpeechEnv {
  /** `window.speechSynthesis`, when the browser has one. */
  synth?: SpeechSynthesisLike | null;
  /** `(text) => new SpeechSynthesisUtterance(text)`. */
  makeUtterance?: ((text: string) => object) | null;
}

/**
 * Say one short line aloud the instant the call is cut, so a participant who
 * is not looking at the screen does not sit in silence wondering whether they
 * were hung up on. Uses the browser's own speech synthesis: it needs no
 * network and no session, which is the point, since both have just gone.
 *
 * English only. The line is fixed English copy, and reading it in another
 * language's voice would be worse than the on-screen message alone.
 *
 * Never throws. Returns a function that stops the speech; the caller invokes
 * it once the recovery call is about to carry audio, so the browser's voice
 * can never talk over the returning assistant or be picked up by the new
 * session's microphone. Calling it twice, or when nothing was started, is safe.
 */
export function startInterimSpeech(env: InterimSpeechEnv, text: string, language: string): () => void {
  const noop = () => {};
  try {
    const synth = env.synth;
    const make = env.makeUtterance;
    if (!synth || !make || !text.trim()) return noop;
    if (!/^en\b/i.test(language || 'en')) return noop;
    // Anything already queued (there should be nothing) must not delay this.
    synth.cancel();
    const utterance = make(text) as { lang?: string; rate?: number; volume?: number };
    utterance.lang = 'en-US';
    utterance.rate = 1;
    utterance.volume = 1;
    synth.speak(utterance);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        synth.cancel();
      } catch {
        /* a speech engine that cannot cancel is not worth failing recovery over */
      }
    };
  } catch {
    return noop;
  }
}

// ---------------------------------------------------------------------------
// Age-eligibility end: let the goodbye be heard
// ---------------------------------------------------------------------------

/** No assistant speech for this long after the goodbye began means it is over. */
export const ELIGIBILITY_GOODBYE_QUIET_MS = 2_500;
/** Never end sooner than this after the signal: the goodbye needs a couple of
 *  seconds to start (measured about 2 s from the server's instruction). */
export const ELIGIBILITY_GOODBYE_MIN_WAIT_MS = 6_000;
/** If the assistant has not started the goodbye by now, end anyway. */
export const ELIGIBILITY_GOODBYE_START_WAIT_MS = 8_000;
/** Hard cap on the whole wait; the server force-ends at 60 s regardless. */
export const ELIGIBILITY_GOODBYE_MAX_WAIT_MS = 30_000;

/**
 * Has the assistant finished the eligibility goodbye, so the voice session can
 * be torn down?
 *
 * When a participant says they are under 18 the server tells the voice model
 * to say a short goodbye (with the crisis lines in it) and tells the browser
 * to end the session. The browser used to end it in the same instant, which
 * hangs up before the first word of that goodbye. This answers "is it safe to
 * hang up yet" from when assistant speech was last heard:
 *
 * - never before ELIGIBILITY_GOODBYE_MIN_WAIT_MS; then
 * - the goodbye started and has been quiet for ELIGIBILITY_GOODBYE_QUIET_MS; or
 * - nothing was said within ELIGIBILITY_GOODBYE_START_WAIT_MS of the signal; or
 * - ELIGIBILITY_GOODBYE_MAX_WAIT_MS has passed, whatever is happening.
 *
 * All times are milliseconds on one clock. `lastAssistantSpeechAt` is the
 * arrival time of the most recent assistant transcript fragment, or null.
 */
export function eligibilityGoodbyeFinished(input: {
  now: number;
  signalledAt: number;
  lastAssistantSpeechAt: number | null;
}): boolean {
  const { now, signalledAt, lastAssistantSpeechAt } = input;
  const waited = now - signalledAt;
  if (waited >= ELIGIBILITY_GOODBYE_MAX_WAIT_MS) return true;
  // The tail of whatever the assistant was saying when the signal arrived can
  // look like "spoke, then went quiet" before the goodbye has even begun.
  if (waited < ELIGIBILITY_GOODBYE_MIN_WAIT_MS) return false;
  const spokeSinceSignal = lastAssistantSpeechAt != null && lastAssistantSpeechAt >= signalledAt;
  if (!spokeSinceSignal) return waited >= ELIGIBILITY_GOODBYE_START_WAIT_MS;
  return now - (lastAssistantSpeechAt as number) >= ELIGIBILITY_GOODBYE_QUIET_MS;
}
