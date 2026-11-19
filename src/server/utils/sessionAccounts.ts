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
/** How long the demo answer outlives the session's end: the last turn of a
 *  voice session is scored as it closes (the same grace as utils/recentTurns). */
export const KNOWN_ACCOUNT_END_GRACE_MS = 2 * 60 * 1000;
const knownDemoSessions = new Map<string, { demo: boolean; endedAt: number | null }>();

/**
 * Record whose session this is, from the request that created it (`role`:
 * the signed-in user's users.role; undefined for an anonymous browser, which
 * is never a demo account). Never throws.
 */
export function rememberSessionAccount(sessionId: string, role: string | null | undefined): void {
  if (!sessionId) return;
  knownDemoSessions.delete(sessionId);
  knownDemoSessions.set(sessionId, { demo: role === 'demo', endedAt: null });
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
  const known = knownDemoSessions.get(sessionId);
  if (!known) return null;
  if (known.endedAt !== null && Date.now() - known.endedAt > KNOWN_ACCOUNT_END_GRACE_MS) {
    knownDemoSessions.delete(sessionId);
    return null;
  }
  return known.demo;
}

/**
 * The session ended (ai-therapist-374): its demo answer is forgotten after
 * KNOWN_ACCOUNT_END_GRACE_MS (a later read falls back to the database, as for
 * a session this process never saw). The participant memory below is kept:
 * the paging fold needs it (see there). Never throws.
 */
export function sessionAccountEnded(sessionId: string): void {
  const known = knownDemoSessions.get(sessionId);
  if (known && known.endedAt === null) known.endedAt = Date.now();
}

// The participant behind a session, from the request that started it
// (ai-therapist-373). The paging layer keys its fold rule by participant and
// reads the participant from the session row; a session whose row was never
// written (a chat start that failed after minting its id, whose check-in is
// still screened) has no row to read, so its page was keyed by a session id
// nobody else uses, its retry was not folded into it (two pages), and its
// link opened a session that does not exist.
//
// Deliberately NOT cleared at session end, withdrawal or account deletion
// (ai-therapist-374): a page about the session inside the paging layer's
// 15-minute fold window must still be keyed by the same participant, or it
// pages twice; after an account deletion the session row's user_id is NULL, so
// this is the only place left that knows. It holds two ids and no content,
// and is bounded by KNOWN_ACCOUNTS_MAX.
const knownParticipants = new Map<string, { userId: number; stored: boolean }>();

/**
 * Record the signed-in participant of a session as it starts. `stored`:
 * false when the session row was never written (the start failed first).
 * Anonymous browsers (no user id) are not recorded. Never throws.
 */
export function rememberSessionParticipant(
  sessionId: string,
  userId: number | null | undefined,
  opts: { stored?: boolean } = {},
): void {
  if (!sessionId || typeof userId !== 'number' || !Number.isInteger(userId)) return;
  knownParticipants.delete(sessionId);
  knownParticipants.set(sessionId, { userId, stored: opts.stored !== false });
  if (knownParticipants.size > KNOWN_ACCOUNTS_MAX) {
    for (const id of knownParticipants.keys()) {
      if (knownParticipants.size <= KNOWN_ACCOUNTS_MAX / 2) break;
      knownParticipants.delete(id);
    }
  }
}

/** The participant remembered at session start, or null when this process
 *  does not know (`stored` false: the session row does not exist). */
export function knownSessionParticipant(sessionId: string): { userId: number; stored: boolean } | null {
  return knownParticipants.get(sessionId) ?? null;
}

/** Test hook. */
export function _forgetSessionAccountsForTests(): void {
  knownDemoSessions.clear();
  knownParticipants.clear();
}
