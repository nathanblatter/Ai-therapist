// Who asked the model to end the session?
//
// The end_session tool is normally the model's own call, made once the
// participant agrees the conversation is over. On a crisis-flagged session that
// call is refused (toolRegistry end_session), because a model that has just
// heard a suicidal disclosure and reaches for "goodbye, please call 988" is
// hanging up on someone in crisis — the failure this whole module exists for.
//
// Two server-driven flows legitimately steer the model into calling end_session
// on ANY session, crisis or not: the duration limit (sessionAutoTerminate) and
// the admin crisis wind-down (crisisIntervention). They record a grant here
// first, and the refusal checks it. Grants are short-lived and in-memory: a
// steer that never produced an end_session call within the window is stale,
// and a process restart drops the hard-end backstops anyway.

const GRANT_TTL_MS = 10 * 60 * 1000;
const grants = new Map<string, number>();

function prune(now: number): void {
  if (grants.size <= 500) return;
  for (const [id, at] of grants) {
    if (now - at > GRANT_TTL_MS) grants.delete(id);
  }
}

/** Record that the server asked the model to end this session. */
export function authorizeModelEnd(sessionId: string): void {
  const now = Date.now();
  grants.set(sessionId, now);
  prune(now);
}

/**
 * True once while a server-issued end request for this session is current.
 * Single-shot: the grant is consumed by the call that uses it, so one steer
 * authorizes one end and a session the model later wants to leave on its own
 * is refused again.
 */
export function isModelEndAuthorized(sessionId: string): boolean {
  const at = grants.get(sessionId);
  if (at === undefined) return false;
  grants.delete(sessionId);
  return Date.now() - at <= GRANT_TTL_MS;
}

/** Drop a grant (session ended, or tests). */
export function clearModelEndAuthorization(sessionId: string): void {
  grants.delete(sessionId);
}

/** Test hook. */
export function _modelEndGrantCountForTests(): number {
  return grants.size;
}
