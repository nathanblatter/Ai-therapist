// Data-access for Qualtrics baseline-survey signups (ai-therapist-149).
// A finished baseline response's ResponseID is claimed exactly once via the
// UNIQUE(response_id) constraint; the stored row links the resulting
// participant account to the Qualtrics response for dataset joins.
import { pool } from '../config/db.js';

export interface QualtricsSignupRow {
  signup_id: number;
  response_id: string;
  survey_id: string;
  user_id: number | null;
  claimed_at: string;
  registered_at: string | null;
}

const SIGNUP_COLUMNS = 'signup_id, response_id, survey_id, user_id, claimed_at, registered_at';

/**
 * Atomically claim a Qualtrics response for account creation. The INSERT's
 * ON CONFLICT DO NOTHING guarantees exactly one caller ever wins, even under
 * concurrent posts. Returns the claimed row, or null when the response was
 * already claimed.
 */
export async function claimQualtricsResponse(
  responseId: string,
  surveyId: string
): Promise<QualtricsSignupRow | null> {
  const result = await pool.query<QualtricsSignupRow>(
    `INSERT INTO qualtrics_signups (response_id, survey_id)
     VALUES ($1, $2)
     ON CONFLICT (response_id) DO NOTHING
     RETURNING ${SIGNUP_COLUMNS}`,
    [responseId, surveyId]
  );
  return result.rows[0] ?? null;
}

/**
 * Release a claim after a failed registration so the participant can retry
 * (e.g. their chosen username was taken). Only removes rows that never
 * produced an account.
 */
export async function releaseQualtricsClaim(signupId: number): Promise<void> {
  await pool.query(
    'DELETE FROM qualtrics_signups WHERE signup_id = $1 AND registered_at IS NULL',
    [signupId]
  );
}

/** Record which user account a claimed response produced. */
export async function markQualtricsSignupRegistered(
  signupId: number,
  userId: number
): Promise<void> {
  await pool.query(
    'UPDATE qualtrics_signups SET user_id = $1, registered_at = now() WHERE signup_id = $2',
    [userId, signupId]
  );
}

/** Look up an existing claim (used by GET /join-study to render an
 *  already-used page instead of the registration form). */
export async function findQualtricsSignup(
  responseId: string
): Promise<QualtricsSignupRow | null> {
  const result = await pool.query<QualtricsSignupRow>(
    `SELECT ${SIGNUP_COLUMNS} FROM qualtrics_signups WHERE response_id = $1`,
    [responseId]
  );
  return result.rows[0] ?? null;
}
