// What is already known about a session's account when it starts
// (ai-therapist-369). No I/O.
//
// The account behind a session is known when the session is created: the
// request carries the signed-in user's role. Remembered here, the crisis
// pipeline need not read it back from the database on every turn, and a
// database that cannot answer does not decide it: before this, a failed read
// ran the full pipeline, so a demo account's session paged a real person. A
// session this process has not seen start (a restart, another instance) is
// read as before (services/suppression sessionSuppressesSafetyPipeline), and a
// failed read there still runs the pipeline (fail toward paging): that case is
// genuinely unknown.

const KNOWN_ACCOUNTS_MAX = 5000;
const knownDemoSessions = new Map<string, boolean>();

/**
 * Record whose session this is, from the request that created it (`role`:
 * the signed-in user's users.role; undefined for an anonymous browser, which
 * is never a demo account). Never throws.
 */
export function rememberSessionAccount(sessionId: string, role: string | null | undefined): void {
  if (!sessionId) return;
  knownDemoSessions.delete(sessionId);
  knownDemoSessions.set(sessionId, role === 'demo');
  if (knownDemoSessions.size > KNOWN_ACCOUNTS_MAX) {
    for (const id of knownDemoSessions.keys()) {
      if (knownDemoSessions.size <= KNOWN_ACCOUNTS_MAX / 2) break;
      knownDemoSessions.delete(id);
    }
  }
}

/** Whether the session belongs to a demo account (users.role 'demo'), as
 *  remembered at session start, or null when this process does not know. */
export function knownDemoAccountSession(sessionId: string): boolean | null {
  return knownDemoSessions.get(sessionId) ?? null;
}

/** Test hook. */
export function _forgetSessionAccountsForTests(): void {
  knownDemoSessions.clear();
}
