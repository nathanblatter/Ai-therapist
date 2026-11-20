// Participant-facing crisis resources: the one place that emits
// `session:crisis-emergency` to a participant's session room, the event the
// browser answers by opening the crisis resource card (988, the text line, 911).
//
// Why this is its own module (ai-therapist-293). The card used to be emitted at
// the END of executeHighRiskResponse: after the intervention log, the on-call
// page, the safety-protocol steer and its log. On GPT-Live the vendor's content
// filter closes the voice session within about half a second of the model
// starting its crisis reply, so in 2 of 4 measured runs the card event went out
// after the session had already closed, and on a cut the server had not yet
// scored (or had scored below high) it never went out at all. The card is the
// one crisis response that does not depend on the voice session surviving, so
// it is now emitted FIRST, from every place that learns the participant needs
// it:
//
//   - the crisis pipeline, the moment a turn scores high (before any DB write);
//   - executeHighRiskResponse, as before (deduplicated against the line above);
//   - the sideband, when the vendor stops a generation (`error` with code
//     content_filter) or closes the session for content or, in a crisis, at
//     its ceiling.
//
// Nothing here throws: an emission problem must never break a crisis path.

import { noteLiveOpeningCrisis } from './liveOpening.service.js';

export type CrisisResourceReason =
  /** Our own pipeline scored the turn high. */
  | 'high_risk'
  /** The vendor's moderation stopped the assistant mid-reply (session may live on). */
  | 'vendor_moderation_stop'
  /** The vendor closed the session for content. */
  | 'vendor_cut'
  /** The vendor's session ceiling ended a session flagged high. */
  | 'vendor_ceiling';

export interface CrisisResourcePayload {
  reason: CrisisResourceReason;
  /** 'high' when our pipeline scored it; null when only the vendor acted. */
  severity?: 'high' | null;
  riskScore?: number | null;
}

/** Repeat emissions of the same kind inside this window are dropped: one
 *  crisis moment is reported by several paths within a second or two of each
 *  other, and the browser should not re-open a card the participant just
 *  closed. Our own high flag and the vendor's actions are tracked separately,
 *  so a vendor stop never swallows the high flag that follows it (the browser
 *  reads `severity: 'high'` to know the session is in crisis). */
export const CRISIS_RESOURCE_DEDUPE_MS = 10_000;

type Kind = 'high' | 'vendor';
const lastEmittedAt = new Map<string, Partial<Record<Kind, number>>>();

// The card for a high flag raised BEFORE the participant's browser is in the
// session room. That is what a pre-session check-in does: its text is scored
// while the session is being started (on chat, before /api/chat/start has even
// answered), so the emit below goes to an empty room and is lost, while
// hasEmittedHighRiskResources then reports the card as shown and the pipeline
// does not send it again for later high turns. The payload is kept here and
// handed to the first participant socket that joins (noteParticipantJoined).
// Per process: a join handled by another node finds nothing here, and in that
// case the room emit has already reached that node through the adapter.
export const CRISIS_RESOURCE_JOIN_REPLAY_MS = 10 * 60 * 1000;
const participantJoined = new Set<string>();
const pendingForJoin = new Map<string, { at: number; event: Record<string, unknown> }>();

function kindOf(reason: CrisisResourceReason): Kind {
  return reason === 'high_risk' ? 'high' : 'vendor';
}

/**
 * Tell the participant's browser to show crisis resources now.
 *
 * @returns true when the event was emitted, false when it was deduplicated or
 *   there is no socket server (tests, scripts).
 */
export function emitCrisisResources(sessionId: string, payload: CrisisResourcePayload, now = Date.now()): boolean {
  try {
    // Our own high flag and a vendor stop or cut take priority over a GPT-Live
    // opening that has not been spoken yet (ai-therapist-315).
    noteLiveOpeningCrisis(sessionId);
    const kind = kindOf(payload.reason);
    const entry = lastEmittedAt.get(sessionId) ?? {};
    const last = entry[kind];
    if (last !== undefined && now - last < CRISIS_RESOURCE_DEDUPE_MS) return false;
    if (!global.io) return false;
    entry[kind] = now;
    lastEmittedAt.set(sessionId, entry);
    if (lastEmittedAt.size > 500) {
      const cutoff = now - 60 * 60 * 1000;
      for (const [id, e] of lastEmittedAt) {
        if (Math.max(e.high ?? 0, e.vendor ?? 0) < cutoff) lastEmittedAt.delete(id);
      }
    }
    const event = {
      sessionId,
      severity: payload.severity ?? null,
      riskScore: payload.riskScore ?? null,
      reason: payload.reason,
    };
    global.io.to(`session:${sessionId}`).emit('session:crisis-emergency', event);
    if (kind === 'high' && !participantJoined.has(sessionId)) {
      pendingForJoin.set(sessionId, { at: now, event });
      if (pendingForJoin.size > 500) {
        for (const [id, p] of pendingForJoin) {
          if (now - p.at > CRISIS_RESOURCE_JOIN_REPLAY_MS) pendingForJoin.delete(id);
        }
      }
    }
    return true;
  } catch (err) {
    console.error(`[CrisisResources] emit failed for ${sessionId.substring(0, 12)}...:`, err);
    return false;
  }
}

/** Has this session's browser already been sent the card for our own high flag? */
export function hasEmittedHighRiskResources(sessionId: string): boolean {
  return lastEmittedAt.get(sessionId)?.high !== undefined;
}

/**
 * A participant's socket has joined the session room. If our own high flag
 * was raised before anyone could receive the card (see pendingForJoin), send
 * it to that socket now. `send` emits to the joining socket only. Returns true
 * when the card was sent. Never throws.
 */
export function noteParticipantJoined(
  sessionId: string,
  send: (event: 'session:crisis-emergency', data: Record<string, unknown>) => void,
  now = Date.now(),
): boolean {
  try {
    participantJoined.add(sessionId);
    if (participantJoined.size > 5000) {
      for (const id of participantJoined) {
        if (participantJoined.size <= 2500) break;
        participantJoined.delete(id);
      }
    }
    const pending = pendingForJoin.get(sessionId);
    if (!pending) return false;
    pendingForJoin.delete(sessionId);
    if (now - pending.at > CRISIS_RESOURCE_JOIN_REPLAY_MS) return false;
    send('session:crisis-emergency', pending.event);
    return true;
  } catch (err) {
    console.error(`[CrisisResources] replay on join failed for ${sessionId.substring(0, 12)}...:`, err);
    return false;
  }
}

/** Drop a session's state (session end / tests). */
export function clearCrisisResourceState(sessionId?: string): void {
  if (sessionId === undefined) {
    lastEmittedAt.clear();
    participantJoined.clear();
    pendingForJoin.clear();
  } else {
    lastEmittedAt.delete(sessionId);
    participantJoined.delete(sessionId);
    pendingForJoin.delete(sessionId);
  }
}
