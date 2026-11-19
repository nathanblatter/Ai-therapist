// ============================================
// VOICE HEADS-UP BEFORE A VENDOR CUT (ai-therapist voice safety, 2026-11-19)
// ============================================
// OpenAI's moderation closes a GPT-Live session within about a second of an
// explicitly suicidal statement (docs/gpt-live.md, "When the vendor's
// moderation stops or cuts a call"). The app then moves the conversation to
// typed chat (the text hand-off), but nothing has told the participant that
// can happen, so from their side the voice just stops at the worst moment. A
// line spoken AFTER the disclosure rarely finishes before the cut.
//
// So the voice model is asked, once per session, to say it EARLIER: at the
// first medium-risk turn (or the first high one, if the voice is still
// connected), woven into its normal reply, that if the voice part drops it is
// not gone and the conversation carries on in writing on their screen.
//
// - The server decides when (the crisis pipeline's band, through the existing
//   risk steer in crisisIntervention.maybeSteerSession); the model phrases it.
// - Behind `system_config.features.voice_heads_up_enabled`, default OFF.
// - Once only: the latch sets when the sideband sees the line in the
//   assistant's own transcript (headsUpSpokenIn), not when it is requested. A
//   request that was not followed by the line within VOICE_HEADS_UP_MISSED_TURNS
//   finished assistant turns (or VOICE_HEADS_UP_MISSED_MS) may be repeated once
//   on a later medium or high steer; never more than VOICE_HEADS_UP_MAX_REQUESTS.
// - The state is per therapy session and lives here, not on the sideband's
//   per-attach state, so a sideband reconnect within the session keeps it. A
//   process restart re-reads it from the session's intervention_actions rows.
// - GPT-Live sessions only, never a crisis recovery voice session (client
//   delegation), and only where typed chat is on: the hand-off the line
//   describes exists only then.
import { pool } from '../config/db.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

/** The `system_config.features` key. Absent or anything but `true` is off. */
export const VOICE_HEADS_UP_FEATURE = 'voice_heads_up_enabled';

/** The example sentence the voice model is given (it may phrase its own). */
export const VOICE_HEADS_UP_EXAMPLE =
  "If the voice part of this drops, I'm not gone. I'll be right there in writing on your screen.";

/** Added to the risk steer (or sent on its own as a clinical steer, below). */
export const VOICE_HEADS_UP_GUIDANCE =
  'Also, once only in this conversation: early in this reply, right after a few warm words acknowledging ' +
  'what they said and before you ask anything about their safety or about suicide, say one short, plain sentence ' +
  'such as: "' +
  VOICE_HEADS_UP_EXAMPLE +
  '" Say it as calm reassurance, not a warning or disclaimer, then carry on with the rest of your reply, ' +
  'including your question about their safety if you were going to ask one. Do not add anything about other ' +
  'people, calls, or help arriving.';

/** The same guidance as a clinical steer of its own, when no risk steer goes out on this turn. */
export const VOICE_HEADS_UP_STEER =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` + VOICE_HEADS_UP_GUIDANCE;

/** At most this many requests per session (the first, and one repeat when it was not said). */
export const VOICE_HEADS_UP_MAX_REQUESTS = 2;
/** A request counts as missed after this many finished assistant turns without the line... */
export const VOICE_HEADS_UP_MISSED_TURNS = 3;
/** ...or this long after it was sent, whichever comes first. */
export const VOICE_HEADS_UP_MISSED_MS = 45_000;
/** The durable record: rows of this type carry the request and the spoken marker. */
const HEADS_UP_ACTION = 'risk_steering';
/** `action_details.trigger` on a standalone request and on the spoken marker. */
export const HEADS_UP_TRIGGER_REQUESTED = 'voice_heads_up';
export const HEADS_UP_TRIGGER_SPOKEN = 'voice_heads_up_spoken';
/** The durable lookup after a restart must not hold a crisis steer back. */
const HYDRATE_DEADLINE_MS = 300;

export interface HeadsUpState {
  requests: number;
  lastRequestAt: number;
  /** Finished assistant turns since the last request, without the line. */
  turnsSinceRequest: number;
  /** When the line was first seen in the assistant's transcript (0 = not yet). */
  spokenAt: number;
  /** Wall-clock time of the participant's newest speech when the request went out. */
  participantSpokeAt: number;
  severity: string;
  riskScore: number;
  /** Delivered with the risk steer ('attached') or as a steer of its own ('separate'). */
  delivery: 'attached' | 'separate';
  touchedAt: number;
}

const states = new Map<string, HeadsUpState>();

function evict(now: number): void {
  if (states.size <= 500) return;
  const cutoff = now - 3 * 60 * 60 * 1000;
  for (const [id, s] of states) if (s.touchedAt < cutoff) states.delete(id);
}

/** Test hook. */
export function _resetVoiceHeadsUpForTests(): void {
  states.clear();
}

/** Forget a session (its conversation is over). */
export function clearVoiceHeadsUp(sessionId: string): void {
  states.delete(sessionId);
}

/** Is the switch on, and is the text hand-off (typed chat) there to describe? Never throws. */
export async function voiceHeadsUpEnabled(): Promise<boolean> {
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const features = ((await getSystemConfig()).features ?? {}) as Record<string, unknown>;
    return features[VOICE_HEADS_UP_FEATURE] === true && features.chat_enabled !== false;
  } catch {
    return false;
  }
}

/**
 * Did the assistant say the heads-up? Two things must both be there: the
 * written continuation (writing / typing, or a chat on the screen) and the
 * voice dropping (or "not gone"). "Text" alone does not count: "call or text
 * 988" is in most crisis replies, and so is "on your screen" for the resource
 * card. Pure.
 */
export function headsUpSpokenIn(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  // Cut off before "in writing" (an interruption, the vendor's cut): the
  // part the participant heard is still unmistakable, and asking again would
  // make the model say it twice (seen in a measured run).
  if (/\bnot gone\b/.test(t) && /\b(drops?|dropped|cuts? out)\b/.test(t)) return true;
  const written =
    /\b(in writing|written|writing|typing|typed|in text|by text)\b/.test(t) ||
    (/\bscreen\b/.test(t) && /\bchat\b/.test(t));
  if (!written) return false;
  const voiceLoss =
    /\b(voice|audio|call|sound|connection)\b[^.!?]{0,40}\b(drops?|dropped|dropping|cuts?|cut|ends?|stops?|goes|disconnects?|fails?)\b/.test(
      t,
    );
  return voiceLoss || /\bnot gone\b/.test(t) || /\b(drops?|dropped)\b/.test(t);
}

/** Read the session's record once in this process (a restart forgets memory). Null when unreadable. */
async function hydrate(sessionId: string): Promise<HeadsUpState | null> {
  const held = states.get(sessionId);
  if (held) return held;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = pool.query(
      `SELECT action_details->>'trigger' AS trigger, action_details->>'voiceHeadsUp' AS heads_up
         FROM intervention_actions
        WHERE session_id = $1 AND action_type = $2
          AND (action_details ? 'voiceHeadsUp' OR action_details->>'trigger' IN ($3, $4))`,
      [sessionId, HEADS_UP_ACTION, HEADS_UP_TRIGGER_REQUESTED, HEADS_UP_TRIGGER_SPOKEN],
    );
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), HYDRATE_DEADLINE_MS);
    });
    const result = await Promise.race([read, deadline]);
    if (!result) return null;
    const rows = result.rows as Array<{ trigger: string | null; heads_up: string | null }>;
    const now = Date.now();
    // Raced in by another caller while we read: theirs is newer.
    const raced = states.get(sessionId);
    if (raced) return raced;
    const state: HeadsUpState = {
      requests: rows.filter((r) => r.trigger === HEADS_UP_TRIGGER_REQUESTED || r.heads_up !== null).length,
      lastRequestAt: 0,
      turnsSinceRequest: VOICE_HEADS_UP_MISSED_TURNS,
      spokenAt: rows.some((r) => r.trigger === HEADS_UP_TRIGGER_SPOKEN) ? now : 0,
      participantSpokeAt: 0,
      severity: 'none',
      riskScore: 0,
      delivery: 'attached',
      touchedAt: now,
    };
    states.set(sessionId, state);
    evict(now);
    return state;
  } catch (err) {
    console.error('[voice-heads-up] could not read the session record (not requested this time):', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: may the heads-up be requested now, given this session's state? */
export function headsUpDueFor(state: HeadsUpState | undefined, severity: string, now: number): boolean {
  if (severity !== 'medium' && severity !== 'high') return false;
  if (!state || state.requests === 0) return true;
  if (state.spokenAt > 0 || state.requests >= VOICE_HEADS_UP_MAX_REQUESTS) return false;
  // The earlier request may still be on its way into the reply: repeat it
  // only once it has clearly been missed.
  return (
    state.turnsSinceRequest >= VOICE_HEADS_UP_MISSED_TURNS || now - state.lastRequestAt >= VOICE_HEADS_UP_MISSED_MS
  );
}

/**
 * Should the steer that is about to go to this voice session carry the
 * heads-up? Checks the switch, the band and the once-only latch. `eligible` is
 * the sideband's answer for this session (a GPT-Live session, not a recovery
 * session, connected). Does not record anything: call markVoiceHeadsUpRequested
 * once the text was actually sent. Never throws.
 */
export async function voiceHeadsUpDue(sessionId: string, severity: string, eligible: boolean): Promise<boolean> {
  if (!eligible || (severity !== 'medium' && severity !== 'high')) return false;
  if (!(await voiceHeadsUpEnabled())) return false;
  const state = await hydrate(sessionId).catch(() => null);
  // Unreadable record (only possible before this process has seen the
  // session): saying it twice is worse than today's behaviour, no line. The
  // next medium or high steer tries again.
  if (state === null) return false;
  return headsUpDueFor(state, severity, Date.now());
}

/** Record a request that was sent (the durable row is the caller's steering row or logHeadsUpRequest). */
export function markVoiceHeadsUpRequested(
  sessionId: string,
  facts: { severity: string; riskScore: number; participantSpokeAt: number; delivery: 'attached' | 'separate' },
): void {
  const now = Date.now();
  const prev = states.get(sessionId);
  states.set(sessionId, {
    requests: (prev?.requests ?? 0) + 1,
    lastRequestAt: now,
    turnsSinceRequest: 0,
    spokenAt: prev?.spokenAt ?? 0,
    participantSpokeAt: facts.participantSpokeAt,
    severity: facts.severity,
    riskScore: facts.riskScore,
    delivery: facts.delivery,
    touchedAt: now,
  });
  evict(now);
}

/** Is a request out that has not been answered with the line yet? Cheap; called on every assistant fragment. */
export function voiceHeadsUpPending(sessionId: string): boolean {
  const s = states.get(sessionId);
  return s !== undefined && s.requests > 0 && s.spokenAt === 0;
}

/** Has the line been heard in this session (as far as this process knows)? */
export function voiceHeadsUpSpoken(sessionId: string): boolean {
  return (states.get(sessionId)?.spokenAt ?? 0) > 0;
}

/**
 * Assistant speech for a session with a request out: `final` is a finished
 * turn, otherwise the text so far of the turn in progress. Sets the latch,
 * records it, and tells the admin dashboards the first time the line is
 * there. Returns true when this call set the latch. Never throws.
 */
export function noteVoiceHeadsUpSpeech(sessionId: string, text: string, final: boolean): boolean {
  const s = states.get(sessionId);
  if (!s || s.requests === 0 || s.spokenAt > 0) return false;
  if (!headsUpSpokenIn(text)) {
    if (final) s.turnsSinceRequest += 1;
    return false;
  }
  const now = Date.now();
  s.spokenAt = now;
  s.touchedAt = now;
  const details = {
    trigger: HEADS_UP_TRIGGER_SPOKEN,
    afterRequestMs: now - s.lastRequestAt,
    afterParticipantMs: s.participantSpokeAt > 0 ? now - s.participantSpokeAt : null,
    request: s.requests,
    severity: s.severity,
    delivery: s.delivery,
  };
  console.log('[voice-heads-up] spoken', JSON.stringify({ session: sessionId.substring(0, 12), ...details }));
  void import('./crisisDetection.service.js')
    .then((m) => m.logInterventionAction(sessionId, HEADS_UP_ACTION, { ...details, riskScore: s.riskScore }))
    .catch((err) => console.error('[voice-heads-up] could not record the spoken line:', err));
  if (global.io) {
    void broadcastAdminEventForSession(
      global.io,
      'live:heads-up-spoken',
      { sessionId, ...details, timestamp: new Date() },
      sessionId,
    );
  }
  return true;
}
