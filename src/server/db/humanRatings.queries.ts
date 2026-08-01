// Human rating rows: therapist/researcher scores on the same six-dimension
// eval rubric the LLM judge uses, one row per (session, rater). Written by
// routes/admin/evals.routes.ts; consumed by services/evalCalibration.service.ts
// to compute judge-vs-human agreement (weighted kappa).
import { pool } from '../config/db.js';

export interface HumanRatingDimension {
  score: number;
  note?: string;
}
export type HumanRatingRubric = Record<string, HumanRatingDimension>;

export interface SessionHumanRatingRow {
  rating_id: number;
  session_id: string;
  rater_user_id: number;
  rater_username?: string; // present on reads that JOIN users
  rubric: HumanRatingRubric;
  overall_notes: string | null;
  rubric_version: string;
  created_at: Date;
  updated_at: Date;
}

/** All ratings for a session (JOIN users for rater_username), newest first. */
export async function getSessionHumanRatings(sessionId: string): Promise<SessionHumanRatingRow[]> {
  const result = await pool.query<SessionHumanRatingRow>(
    `SELECT hr.*, u.username AS rater_username
     FROM session_human_ratings hr
     LEFT JOIN users u ON u.userid = hr.rater_user_id
     WHERE hr.session_id = $1
     ORDER BY hr.updated_at DESC`,
    [sessionId]
  );
  return result.rows;
}

/** Upsert the calling rater's rating for a session (ON CONFLICT (session_id,
 *  rater_user_id) DO UPDATE rubric/overall_notes/rubric_version, updated_at=now). */
export async function upsertSessionHumanRating(
  sessionId: string,
  raterUserId: number,
  rubric: HumanRatingRubric,
  overallNotes: string | null,
  rubricVersion: string
): Promise<SessionHumanRatingRow> {
  const result = await pool.query<SessionHumanRatingRow>(
    `INSERT INTO session_human_ratings (session_id, rater_user_id, rubric, overall_notes, rubric_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id, rater_user_id) DO UPDATE
       SET rubric = EXCLUDED.rubric,
           overall_notes = EXCLUDED.overall_notes,
           rubric_version = EXCLUDED.rubric_version,
           updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [sessionId, raterUserId, JSON.stringify(rubric), overallNotes, rubricVersion]
  );
  return result.rows[0];
}

/** Paired observations for calibration: every (human rating, LLM eval) pair on
 *  the same session where session_evals.prompt_version = $1 and
 *  session_human_ratings.rubric_version = $2. One row per (session, rater). */
export interface CalibrationPairRow {
  session_id: string;
  rater_user_id: number;
  human_rubric: HumanRatingRubric;
  llm_rubric: Record<string, { score: number; rationale: string }>;
  prompt_version: string;
}

export async function getCalibrationPairs(
  promptVersion: string,
  rubricVersion: string
): Promise<CalibrationPairRow[]> {
  const result = await pool.query<CalibrationPairRow>(
    `SELECT hr.session_id, hr.rater_user_id, hr.rubric AS human_rubric,
            se.rubric AS llm_rubric, se.prompt_version
     FROM session_human_ratings hr
     JOIN session_evals se
       ON se.session_id = hr.session_id AND se.prompt_version = $1
     WHERE hr.rubric_version = $2
     ORDER BY hr.session_id, hr.rater_user_id`,
    [promptVersion, rubricVersion]
  );
  return result.rows;
}

/** Distinct session_evals.prompt_version values with at least one paired human rating. */
export async function getCalibrationPromptVersions(): Promise<string[]> {
  const result = await pool.query<{ prompt_version: string }>(
    `SELECT DISTINCT se.prompt_version
     FROM session_evals se
     JOIN session_human_ratings hr ON hr.session_id = se.session_id
     ORDER BY se.prompt_version`
  );
  return result.rows.map(r => r.prompt_version);
}
