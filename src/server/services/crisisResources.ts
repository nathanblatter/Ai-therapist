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
    global.io.to(`session:${sessionId}`).emit('session:crisis-emergency', {
      sessionId,
      severity: payload.severity ?? null,
      riskScore: payload.riskScore ?? null,
      reason: payload.reason,
    });
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

/** Drop a session's state (session end / tests). */
export function clearCrisisResourceState(sessionId?: string): void {
  if (sessionId === undefined) lastEmittedAt.clear();
  else lastEmittedAt.delete(sessionId);
}
