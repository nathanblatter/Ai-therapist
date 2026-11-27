// Skip post-session model work for red-team harness sessions (ai-therapist-383).
//
// Every session that ends runs redaction (gpt-5, double pass), the redaction
// leak check, session naming and insights. For a red-team harness session that
// work is pure spend unless the scenario asserts on its output: the
// 2026-11-19 billing trace put it at about $0.012 per harness session, far
// more when redaction fell back to per-message calls, with no way to switch it
// off.
//
// The gate must NEVER match a real participant, so it needs BOTH:
//   1. a harness-process signal no request can set: REDTEAM_HARNESS_PROCESS=1,
//      which only the harness CLI (src/redteam/cli.ts, which boots the server
//      in-process) puts into its own environment. It is read once, at the first
//      session end in the process, and is never set on stage or prod. As a
//      second lock it is ignored under NODE_ENV=production (the harness forces
//      NODE_ENV=test for its in-process server; deployed servers run
//      production);
//   2. the session's user in the reserved harness id range
//      (RESERVED_PARTICIPANT_USERID_MIN and up; the users sequence never gets
//      there, scripts/redteam-seed-user.mjs seeds the harness participant into
//      it).
// If either is missing, or the lookup fails, post-session work runs exactly
// as before. A scenario that asserts on post-session output (CONF-07/08, the
// memory and multi-session scenarios) opts its sessions back in through
// optInPostSessionWork(), which only the harness code in the same process can
// call.
//
// Enforced at the jobs themselves (redactSession, which also starts the leak
// check; generateSessionNameAsync; generateSessionInsightsAsync), so every end
// path is covered: the chat, realtime and admin end routes, the lifecycle and
// abandon paths, the auto-terminate timer, the minor safeguard, and the
// 15-minute redaction sweep.

/** Userids at or above this are reserved for the harness; the users sequence
 *  will not reach it. Keep in step with scripts/redteam-seed-user.mjs.
 *  (Re-exported by src/redteam/participantIdentity.ts.) */
export const RESERVED_PARTICIPANT_USERID_MIN = 1_900_000_000;

/** The env var the harness CLI sets in its own process. */
export const HARNESS_PROCESS_ENV = 'REDTEAM_HARNESS_PROCESS';

export type PostSessionJob = 'redaction' | 'naming' | 'insights' | 'alliance';

let processSignal: boolean | null = null;
const optedIn = new Set<string>();
/** session id -> skip decision, so each session is looked up and logged once. */
const decided = new Map<string, boolean>();

/** Set by the in-app runner (harnessRunner.service.ts) on the harness child it
 *  spawns against a deployment's live database. */
export const REDTEAM_TRIGGER_ENV = 'REDTEAM_TRIGGER';

/**
 * Called by the harness CLI before the server loads: turn the harness-process
 * signal on for a standalone run, and actively remove it under the in-app
 * runner (REDTEAM_TRIGGER present), whose child runs against a live database
 * and inherits the deployment's environment, so a variable that leaked into a
 * container's environment cannot reach it.
 */
export function setHarnessProcessSignal(env: NodeJS.ProcessEnv): void {
  if (env[REDTEAM_TRIGGER_ENV] !== undefined) delete env[HARNESS_PROCESS_ENV];
  else env[HARNESS_PROCESS_ENV] = '1';
}

/** The signal is on only when set to exactly "1", outside NODE_ENV=production,
 *  and never in a process the in-app runner started (REDTEAM_TRIGGER present). */
export function harnessProcessSignalOn(env: NodeJS.ProcessEnv): boolean {
  return env[HARNESS_PROCESS_ENV] === '1' && env.NODE_ENV !== 'production' && env[REDTEAM_TRIGGER_ENV] === undefined;
}

function isHarnessProcess(): boolean {
  if (processSignal === null) processSignal = harnessProcessSignalOn(process.env);
  return processSignal;
}

/** The scenario asserts on this session's post-session output: run the jobs. */
export function optInPostSessionWork(sessionId: string): void {
  optedIn.add(sessionId);
}

/** Sessions whose post-session work this process skipped (for the harness summary). */
export function skippedPostSessionSessions(): string[] {
  return [...decided].filter(([, skip]) => skip).map(([id]) => id);
}

/** Test hook. */
export function _resetHarnessPostSessionForTests(): void {
  processSignal = null;
  optedIn.clear();
  decided.clear();
}

/**
 * True when `job` should NOT run for this session: a harness process, a user
 * in the reserved harness range, and no opt-in. Never throws; any doubt
 * (a failed lookup, no session row, no user) means run the job.
 */
export async function shouldSkipPostSessionWork(sessionId: string, job: PostSessionJob): Promise<boolean> {
  if (!isHarnessProcess()) return false;
  if (optedIn.has(sessionId)) return false;
  const known = decided.get(sessionId);
  if (known !== undefined) return known;

  let skip = false;
  try {
    const { pool } = await import('../config/db.js');
    const { rows } = await pool.query<{ user_id: number | string | null }>(
      `SELECT user_id FROM therapy_sessions WHERE session_id = $1`,
      [sessionId],
    );
    const userId = Number(rows[0]?.user_id);
    skip = rows[0]?.user_id != null && Number.isFinite(userId) && userId >= RESERVED_PARTICIPANT_USERID_MIN;
  } catch {
    skip = false;
  }
  // A concurrent check may have decided (or an opt-in landed) meanwhile.
  if (optedIn.has(sessionId)) return false;
  const again = decided.get(sessionId);
  if (again !== undefined) return again;
  decided.set(sessionId, skip);
  if (skip) {
    console.log(
      `[post-session] skipped for harness session ${sessionId.substring(0, 24)} (harness process, reserved-range user, ` +
        `scenario did not opt in): no redaction, leak check, naming or insights (first job: ${job})`,
    );
  }
  return skip;
}
