// Participant study status (Phase 2 withdrawal capture, migration 087).
// Status is stamped by the Qualtrics withdrawal-survey ingest or by an admin;
// withdrawn/paused participants are blocked from starting new sessions.
import { pool } from '../config/db.js';

export type StudyStatus = 'active' | 'paused' | 'withdrawn';

export async function getStudyStatus(userId: number): Promise<StudyStatus> {
  const { rows } = await pool.query<{ study_status: StudyStatus }>(
    `SELECT study_status FROM users WHERE userid = $1`,
    [userId]
  );
  return rows[0]?.study_status ?? 'active';
}

export interface StudyStatusDetail {
  study_status: StudyStatus;
  study_status_changed_at: string | null;
  study_status_source: string | null;
}

/** Status plus provenance for the admin study-status panel. Null when the
 *  user row does not exist (route 404s). */
export async function getStudyStatusDetail(userId: number): Promise<StudyStatusDetail | null> {
  const { rows } = await pool.query<StudyStatusDetail>(
    `SELECT study_status, study_status_changed_at, study_status_source
       FROM users WHERE userid = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

/**
 * Set a participant's study status. Returns true when the row changed —
 * setting the same status twice is a no-op, which keeps the withdrawal-survey
 * ingest idempotent across webhook + bulk-sync overlap.
 */
export async function setStudyStatus(
  userId: number,
  status: StudyStatus,
  source: string
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users
        SET study_status = $2,
            study_status_changed_at = now(),
            study_status_source = $3
      WHERE userid = $1 AND study_status IS DISTINCT FROM $2`,
    [userId, status, source]
  );
  return (result.rowCount ?? 0) > 0;
}
