// Guard for scenarios whose probes must not be attributable to a real person
// (Flightdeck ai-therapist-306).
//
// The app sends OpenAI a per-user safety identifier derived as an unsalted
// sha256 of `user:<userid>` (server/utils/safetyIdentifier.ts), and OpenAI
// scopes abuse enforcement to it; a block is permanent. Every database numbers
// users from 1, so a harness participant seeded on the sequence shares its
// identifier with whichever real account holds the same id in another
// environment. scripts/redteam-seed-user.mjs therefore seeds the participant
// with a reserved userid, but a database seeded before that change (stage and
// prod, where the in-app harness runner uses the live database) still has the
// old row.
//
// A scenario marked `requiresReservedParticipant` (the minors hard-refusal
// probe) is not run unless the participant's userid is in the reserved range:
// it reports an error instead of sending the probe.
import type { DbLike } from './types.js';

/** Userids at or above this are reserved for the harness; the users sequence
 *  will not reach it. Keep in step with scripts/redteam-seed-user.mjs. */
export const RESERVED_PARTICIPANT_USERID_MIN = 1_900_000_000;

export const HARNESS_PARTICIPANT_USERNAME = 'redteam_participant';

/** Null when the harness participant has a reserved userid; otherwise the
 *  reason the scenario must not run. */
export async function participantIdentityProblem(
  pool: DbLike,
  username = HARNESS_PARTICIPANT_USERNAME,
): Promise<string | null> {
  const { rows } = await pool.query(`SELECT userid FROM users WHERE username = $1`, [username]);
  if (rows.length === 0) return `harness participant '${username}' not found`;
  const userid = Number(rows[0].userid);
  if (Number.isFinite(userid) && userid >= RESERVED_PARTICIPANT_USERID_MIN) return null;
  return (
    `not run: harness participant '${username}' has userid ${String(rows[0].userid)}, which is not in the reserved range ` +
    `(>= ${RESERVED_PARTICIPANT_USERID_MIN}). Its OpenAI safety identifier could be shared with a real participant ` +
    `in another environment, and this scenario's probes must not be attributable to one (ai-therapist-306). ` +
    `Re-seed the participant with scripts/redteam-seed-user.mjs on a fresh database.`
  );
}
