// Data-access for retention-driven deletion (ai-therapist-97). The only place
// data_deletion_log is written and the recording age-out / wiped-user-grace
// selects live. Orchestration (ordering, MinIO calls, run_id) is in
// services/dataRetention.service.ts.
import { pool } from '../config/db.js';

export interface RecordingRow {
  session_id: string;
  recording_object_key: string | null;
  /** Participant-only track (migration 086); aged out alongside the mix. */
  participant_recording_object_key: string | null;
  user_id: number | null;
}

/**
 * Non-demo sessions whose recording is older than `days` — the age-out set.
 * Ordered for stable, testable processing.
 */
export async function getRecordingsToAgeOut(days: number): Promise<RecordingRow[]> {
  const result = await pool.query<RecordingRow>(
    `SELECT session_id, recording_object_key, participant_recording_object_key, user_id
       FROM therapy_sessions
      WHERE (recording_object_key IS NOT NULL OR participant_recording_object_key IS NOT NULL)
        AND is_demo IS NOT TRUE
        AND created_at < now() - ($1 || ' days')::interval
      ORDER BY created_at, session_id`,
    [days]
  );
  return result.rows;
}

/**
 * Orphaned (user_id IS NULL), ended, non-demo sessions whose account was wiped
 * more than `graceDays` ago — early recording hard-delete after account wipe.
 * Uses ended_at as the grace clock (falls back to created_at if unset).
 */
export async function getOrphanedRecordingsPastGrace(graceDays: number): Promise<RecordingRow[]> {
  const result = await pool.query<RecordingRow>(
    `SELECT session_id, recording_object_key, participant_recording_object_key, user_id
       FROM therapy_sessions
      WHERE (recording_object_key IS NOT NULL OR participant_recording_object_key IS NOT NULL)
        AND is_demo IS NOT TRUE
        AND user_id IS NULL
        AND status = 'ended'
        AND COALESCE(ended_at, created_at) < now() - ($1 || ' days')::interval
      ORDER BY created_at, session_id`,
    [graceDays]
  );
  return result.rows;
}

/** Null out the recording_* columns after the MinIO object has been deleted. */
export async function clearRecordingColumns(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE therapy_sessions
        SET recording_object_key = NULL,
            recording_status = NULL,
            recording_duration_ms = NULL,
            recording_sample_rate = NULL,
            recording_size_bytes = NULL,
            participant_recording_object_key = NULL,
            participant_recording_status = NULL,
            participant_recording_duration_ms = NULL,
            participant_recording_sample_rate = NULL,
            participant_recording_size_bytes = NULL
      WHERE session_id = $1`,
    [sessionId]
  );
}

export interface DeletionLogInput {
  runId: string;
  artifactType: 'recording_object' | 'session_content' | 'user_account' | 'survey_response';
  artifactRef: string;
  sessionId: string | null;
  userId: number | null;
  reason: 'recording_retention' | 'wiped_user_grace' | 'manual_admin' | 'participant_request';
  policySnapshot: unknown;
  triggeredBy: 'scheduler' | 'manual';
  triggeredByUser: string | null;
  success: boolean;
  errorMessage: string | null;
}

/** Append one audit row per deleted artifact. */
export async function insertDeletionLog(input: DeletionLogInput): Promise<void> {
  await pool.query(
    `INSERT INTO data_deletion_log
       (run_id, artifact_type, artifact_ref, session_id, user_id, reason,
        policy_snapshot, triggered_by, triggered_by_user, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.runId, input.artifactType, input.artifactRef, input.sessionId, input.userId,
      input.reason, JSON.stringify(input.policySnapshot), input.triggeredBy,
      input.triggeredByUser, input.success, input.errorMessage,
    ]
  );
}

export interface DeletionLogRow {
  deletion_id: string;
  run_id: string;
  executed_at: Date;
  artifact_type: string;
  artifact_ref: string;
  session_id: string | null;
  user_id: number | null;
  reason: string;
  triggered_by: string;
  triggered_by_user: string | null;
  success: boolean;
  error_message: string | null;
}

/** Paged deletion-log view for the admin surface. */
export async function getDataDeletionLog(limit = 50, offset = 0): Promise<{ entries: DeletionLogRow[]; total: number }> {
  const entries = await pool.query<DeletionLogRow>(
    `SELECT deletion_id, run_id, executed_at, artifact_type, artifact_ref, session_id,
            user_id, reason, triggered_by, triggered_by_user, success, error_message
       FROM data_deletion_log
      ORDER BY executed_at DESC, deletion_id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const totalRes = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM data_deletion_log`);
  return { entries: entries.rows, total: parseInt(totalRes.rows[0].count, 10) };
}
