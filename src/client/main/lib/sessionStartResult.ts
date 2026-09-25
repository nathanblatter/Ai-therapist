/**
 * Outcome of a voice session start request (POST /api/live/session).
 *
 * The server can refuse a start *synchronously* — a rate limit, quiet hours, a
 * withdrawn participant, a rolled-back voice backend, an already-active
 * session. Those refusals are terminal: nothing will arrive on the data channel
 * afterwards, because no session was ever created.
 *
 * Before ai-therapist-227 the start function swallowed them (it returned
 * `undefined` exactly as it did on success), so the content-filter voice
 * recovery could not tell "the server said no" from "the connection is slow".
 * It fell through to its `session.started` poll and burned the full ~23s
 * timeout — twice — while a participant in crisis waited on "I'm coming right
 * back". Returning a discriminated result lets that caller fail over to the
 * text continuation immediately.
 */
export type SessionStartRefusal =
  | 'rate_limited'
  | 'quiet_hours'
  | 'study_status'
  | 'identifier_blocked'
  | 'live_not_active'
  | 'session_exists';

export type SessionStartResult =
  | { ok: true }
  | { ok: false; refusal: SessionStartRefusal };

export const SESSION_START_OK: SessionStartResult = { ok: true };

export function sessionStartRefused(refusal: SessionStartRefusal): SessionStartResult {
  return { ok: false, refusal };
}

/** Body shape we care about in a refusal response; everything else is ignored. */
export interface SessionStartErrorBody {
  error?: string;
  [key: string]: unknown;
}

/**
 * Map an HTTP status + parsed body to the refusal it represents, or `null` when
 * the response is not a recognised refusal (the caller then treats a non-OK
 * status as a transport-level failure and throws).
 *
 * `body` may be null when the response carried no JSON.
 */
export function classifySessionStartRefusal(
  status: number,
  body: SessionStartErrorBody | null,
): SessionStartRefusal | null {
  if (status === 429) return 'rate_limited';
  if (status === 403) {
    if (body?.error === 'quiet_hours') return 'quiet_hours';
    if (body?.error === 'study_status') return 'study_status';
    if (body?.error === 'identifier_blocked') return 'identifier_blocked';
    return null;
  }
  if (status === 409) {
    if (body?.error === 'live_not_active') return 'live_not_active';
    return null;
  }
  return null;
}

/** Log/telemetry-friendly description of a refusal. Never shown to participants. */
export function describeSessionStartRefusal(refusal: SessionStartRefusal): string {
  switch (refusal) {
    case 'rate_limited':
      return 'Server refused the session start: rate limited';
    case 'quiet_hours':
      return 'Server refused the session start: quiet hours';
    case 'study_status':
      return 'Server refused the session start: study status';
    case 'identifier_blocked':
      return 'Server refused the session start: identifier blocked';
    case 'live_not_active':
      return 'Server refused the session start: Live backend is not active';
    case 'session_exists':
      return 'Server refused the session start: a session is already active';
  }
}
