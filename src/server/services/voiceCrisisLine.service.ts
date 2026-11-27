// ============================================
// THE CRISIS LINE, SPOKEN ONCE AT MEDIUM RISK (ai-therapist-406)
// ============================================
// Measured 2026-11-26: when the voice model answered a medium-risk disclosure
// (passive ideation) itself, it did not name a crisis line aloud in 19 of 19
// replies. Nothing had asked it to. The medium steer said "follow your crisis
// protocol", but the protocol and the crisis numbers live in the clinical
// prompt on the delegated backend; the voice model's own instructions
// (buildLiveInstructions) carry neither. At medium risk the server pushes no
// resource card to a voice session's screen either (typed chat gets one since
// ai-therapist-401; in voice it is the high-risk response), so a
// participant who disclosed passive ideation by voice was given no number at
// all unless the turn happened to be delegated to the backend.
//
// So the first medium steer of a voice session now asks for it in words: one
// short sentence naming 988, said once.
//
// - Voice only (the realtime steer in crisisIntervention.maybeSteerSession).
//   Typed chat has its own steer, which already asks for the resources in the
//   reply.
// - The participant's own risk only: a steer about someone else's crisis or
//   about harming another person has its own text.
// - Once: the sentence is asked for on the first medium steer. It is asked
//   for one more time, on a later medium steer, only if no assistant turn
//   since the first request named the line (the server reads what the model
//   actually said). Never more than VOICE_CRISIS_LINE_MAX_REQUESTS, and the
//   wording itself tells the model not to repeat it. Steers are at least
//   STEER_COOLDOWN_MS apart, so the line is never requested on every turn.
// - Two instructions reach the model on such a turn: the steer, then the
//   risk-check requirement ("ask ONE gentle, direct question"). With the
//   sentence only in the first, 2 of 8 voice-layer replies asked the question
//   and left the number out (both after the reply had been interrupted and
//   resumed). So the second instruction restates the same sentence when the
//   first one carried it; that is one request, said once.
// - The state is in memory, per therapy session. A process restart forgets
//   it, which can cost at most one extra request in that session.
import { recentTurns } from '../utils/recentTurns.js';

/** Added to the end of the first medium-risk voice steer of a session. */
export const VOICE_CRISIS_LINE_GUIDANCE =
  'Also, once only in this conversation: after a few warm words and before any question, say one short ' +
  'sentence such as: "If it ever gets to be too much, you can call or text 988, any time, day or night." Do not ' +
  'repeat it in later replies unless they ask.';

/** The first request, and one repeat when the line was not then said. */
export const VOICE_CRISIS_LINE_MAX_REQUESTS = 2;

/**
 * The risk-check requirement (crisisIntervention.maybeRequireRiskCheck) is a
 * second instruction sent moments after the steer on the same turn. It
 * restates the sentence when the steer asked for it this recently, so that
 * the instruction the model reads last also carries it.
 */
export const VOICE_CRISIS_LINE_SAME_TURN_MS = 10_000;

interface CrisisLineState {
  requests: number;
  firstRequestAt: number;
  lastRequestAt: number;
  /** An assistant turn after the first request named the line. Latched: the
   *  recent-turns window holds only the last few turns, and a long session
   *  must not forget that the line was said. */
  spoken: boolean;
  touchedAt: number;
}

const states = new Map<string, CrisisLineState>();

function evict(now: number): void {
  if (states.size <= 500) return;
  const cutoff = now - 3 * 60 * 60 * 1000;
  for (const [id, s] of states) if (s.touchedAt < cutoff) states.delete(id);
}

/**
 * Does this text name the 988 line? The voice transcript renders the number
 * as digits, spaced or hyphenated digits, or words. Pure.
 */
export function namesCrisisLine(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return /\b9\W{0,3}8\W{0,3}8\b/.test(t) || /\bnine\W{1,3}eight\W{1,3}eight\b/.test(t);
}

/**
 * Should this medium-risk voice steer ask for the crisis line? True for the
 * first one of the session; true once more when no assistant turn since the
 * first request named the line. Never throws.
 */
export function voiceCrisisLineDue(sessionId: string, now: number = Date.now()): boolean {
  try {
    const state = states.get(sessionId);
    if (!state) return true;
    state.touchedAt = now;
    if (state.spoken || state.requests >= VOICE_CRISIS_LINE_MAX_REQUESTS) return false;
    const turns = recentTurns(sessionId)?.turns ?? [];
    return !turns.some((t) => t.role === 'assistant' && t.at >= state.firstRequestAt && namesCrisisLine(t.content));
  } catch {
    return false;
  }
}

/** A steer carrying the request reached the voice model. */
export function markVoiceCrisisLineRequested(sessionId: string, now: number = Date.now()): void {
  const state = states.get(sessionId);
  if (state) {
    state.requests += 1;
    state.lastRequestAt = now;
    state.touchedAt = now;
    return;
  }
  states.set(sessionId, { requests: 1, firstRequestAt: now, lastRequestAt: now, spoken: false, touchedAt: now });
  evict(now);
}

/**
 * A finished assistant voice turn. Once the line has been asked for, the
 * first turn that names it settles the matter for the rest of the session.
 * (Before any request nothing is latched: the line said in passing earlier
 * does not stand in for saying it when the participant discloses.)
 */
export function noteVoiceCrisisLineSpoken(sessionId: string, text: string | null | undefined): void {
  const state = states.get(sessionId);
  if (state && !state.spoken && namesCrisisLine(text)) state.spoken = true;
}

/** Did a steer on this same turn (moments ago) ask for the line? Not a request of its own. */
export function voiceCrisisLineJustRequested(sessionId: string, now: number = Date.now()): boolean {
  const state = states.get(sessionId);
  return !!state && now - state.lastRequestAt <= VOICE_CRISIS_LINE_SAME_TURN_MS;
}

/** Forget a session (its conversation is over). */
export function clearVoiceCrisisLine(sessionId: string): void {
  states.delete(sessionId);
}

/** Test hook. */
export function _resetVoiceCrisisLineForTests(): void {
  states.clear();
}
