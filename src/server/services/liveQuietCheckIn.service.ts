// ============================================
// A CHECK-IN WHEN THE PARTICIPANT GOES QUIET AFTER A SAFETY QUESTION (ai-therapist-414)
// ============================================
// Measured 2026-11-26 (run-quiet-after-disclosure): in 2 of 4 calls the voice
// assistant asked "are you having thoughts of suicide?", the participant said
// nothing, and the assistant said nothing more for the remaining 49.5 s of the
// call. GPT-Live never speaks unprompted, so nothing was going to re-engage
// them. A silence after that question can be someone gathering themselves; it
// can also be someone who has put the phone down.
//
// The rule (conservative defaults, each a named constant below):
// - Armed when a finished assistant turn asks about suicide, self-harm or the
//   participant's safety (crisisDetection.asksSafetyQuestion, the same screen
//   the crisis pipeline uses to read the reply to such a question).
// - If neither side has spoken LIVE_QUIET_CHECK_IN_AFTER_MS later, the voice
//   model is asked, once, to say one short sentence: no rush, still here. It
//   is told not to repeat the question.
// - Once per silence: nothing more is sent until the participant has spoken
//   again, whatever the model says in its check-in. And at most
//   LIVE_QUIET_CHECK_IN_MAX_PER_SESSION in a session.
// - Any participant speech cancels a pending check-in.
// - GPT-Live sessions only (the sideband's commentary channel).
//
// This file owns the rule and the timer. The sideband supplies what it knows
// about the call (QuietCheckInDeps) and makes each check-in visible to staff.

/** Quiet time after a safety question before the check-in. */
export const LIVE_QUIET_CHECK_IN_AFTER_MS = 20_000;
/** At most this many check-ins in one session. */
export const LIVE_QUIET_CHECK_IN_MAX_PER_SESSION = 2;
/** Sent as commentary: something the voice model should say aloud now. */
export const LIVE_QUIET_CHECK_IN_COMMENTARY =
  'The participant has been quiet since you asked about their safety. Say one short, gentle sentence now so they ' +
  'know there is no rush and that you are still with them, for example: "Take your time. I\'m still here with you." ' +
  'Do not repeat your question, do not ask a new one and do not add anything else. Then wait for them.';

/** A timer that fires this much early still counts as the full quiet period. */
const TIMER_SLACK_MS = 250;

export interface QuietCheckInRecord {
  /** Time since the assistant last spoke when the check-in was sent. */
  quietMs: number;
  /** The commentary reached the voice model. */
  delivered: boolean;
  /** Which check-in of the session this is (1-based). */
  count: number;
}

/** What the sideband knows about a call. Times are wall-clock ms, 0 = never. */
export interface QuietCheckInDeps {
  /** The session is attached, open and not closing. */
  isOpen(sessionId: string): boolean;
  lastAssistantSpeechAt(sessionId: string): number;
  lastParticipantSpeechAt(sessionId: string): number;
  /** Ask the voice model to say this now. False when it could not be sent. */
  say(sessionId: string, text: string): Promise<boolean>;
  /** Make the check-in visible to staff. */
  record(sessionId: string, info: QuietCheckInRecord): Promise<void> | void;
  /** The safety-question screen; the default is crisisDetection.asksSafetyQuestion. */
  asksSafetyQuestion?: (text: string) => boolean;
}

interface QuietState {
  timer: NodeJS.Timeout | null;
  armedAt: number;
  sent: number;
  /** A check-in was sent for the current silence; cleared when the participant speaks. */
  awaitingParticipant: boolean;
  touchedAt: number;
}

const states = new Map<string, QuietState>();

function stateFor(sessionId: string, now: number): QuietState {
  let state = states.get(sessionId);
  if (!state) {
    state = { timer: null, armedAt: 0, sent: 0, awaitingParticipant: false, touchedAt: now };
    states.set(sessionId, state);
    if (states.size > 500) {
      const cutoff = now - 3 * 60 * 60 * 1000;
      for (const [id, s] of states) {
        if (s.touchedAt < cutoff && !s.timer) states.delete(id);
      }
    }
  }
  state.touchedAt = now;
  return state;
}

function disarm(state: QuietState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

function schedule(sessionId: string, state: QuietState, delayMs: number, deps: QuietCheckInDeps): void {
  disarm(state);
  const timer = setTimeout(() => {
    state.timer = null;
    void quietCheck(sessionId, deps);
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

async function defaultScreen(): Promise<(text: string) => boolean> {
  const { asksSafetyQuestion } = await import('./crisisDetection.service.js');
  return asksSafetyQuestion;
}

/**
 * A finished assistant turn. Arms the check-in when the turn asks a safety
 * question, unless one was already sent for this silence or the session has
 * had its share. Never throws.
 */
export async function noteAssistantTurnForQuietCheckIn(
  sessionId: string,
  text: string,
  deps: QuietCheckInDeps,
): Promise<void> {
  try {
    const asks = deps.asksSafetyQuestion ?? (await defaultScreen());
    if (!asks(text)) return;
    const now = Date.now();
    const state = stateFor(sessionId, now);
    if (state.awaitingParticipant || state.sent >= LIVE_QUIET_CHECK_IN_MAX_PER_SESSION) return;
    // The participant already answering (their words arrive while the
    // assistant's turn is still being closed) is not a silence.
    const lastAssistant = deps.lastAssistantSpeechAt(sessionId) || now;
    if (deps.lastParticipantSpeechAt(sessionId) > lastAssistant) return;
    state.armedAt = lastAssistant;
    schedule(sessionId, state, Math.max(0, lastAssistant + LIVE_QUIET_CHECK_IN_AFTER_MS - now), deps);
  } catch (err) {
    console.error(`[Live] quiet check-in could not be armed for ${sessionId.substring(0, 12)}...:`, err);
  }
}

/** The participant spoke: no check-in is due, and a later silence may get one. */
export function noteParticipantSpeechForQuietCheckIn(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  disarm(state);
  state.awaitingParticipant = false;
}

/** The call's connection is going away: stop the timer, keep the counts. */
export function stopQuietCheckIn(sessionId: string): void {
  const state = states.get(sessionId);
  if (state) disarm(state);
}

/** Forget a session (its conversation is over). */
export function clearQuietCheckIn(sessionId: string): void {
  stopQuietCheckIn(sessionId);
  states.delete(sessionId);
}

/** Test hook. */
export function _resetQuietCheckInForTests(): void {
  for (const state of states.values()) disarm(state);
  states.clear();
}

async function quietCheck(sessionId: string, deps: QuietCheckInDeps): Promise<void> {
  const state = states.get(sessionId);
  if (!state) return;
  try {
    if (!deps.isOpen(sessionId)) return;
    if (state.awaitingParticipant || state.sent >= LIVE_QUIET_CHECK_IN_MAX_PER_SESSION) return;
    // Normally cancelled as the participant's words arrive; checked again here.
    if (deps.lastParticipantSpeechAt(sessionId) > state.armedAt) return;
    const now = Date.now();
    // The assistant has spoken since the question (the rest of a reply, an
    // answer coming back from the backend): the quiet period starts from its
    // last words.
    const quietMs = now - Math.max(deps.lastAssistantSpeechAt(sessionId), state.armedAt);
    if (quietMs < LIVE_QUIET_CHECK_IN_AFTER_MS - TIMER_SLACK_MS) {
      schedule(sessionId, state, LIVE_QUIET_CHECK_IN_AFTER_MS - quietMs, deps);
      return;
    }
    state.awaitingParticipant = true;
    state.sent += 1;
    const count = state.sent;
    let delivered = false;
    try {
      delivered = await deps.say(sessionId, LIVE_QUIET_CHECK_IN_COMMENTARY);
    } catch (err) {
      console.error(`[Live] quiet check-in could not be sent for ${sessionId.substring(0, 12)}...:`, err);
    }
    await deps.record(sessionId, { quietMs, delivered, count });
  } catch (err) {
    console.error(`[Live] quiet check-in failed for ${sessionId.substring(0, 12)}...:`, err);
  }
}
