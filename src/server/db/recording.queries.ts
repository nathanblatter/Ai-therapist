// Data-access for session audio recordings. The mixed mic+assistant audio is
// teed from the participant's browser, buffered server-side, and stored in
// object storage; these queries track the resulting object on the session row.
import { pool } from '../config/db.js';

export interface SessionRecordingUpdate {
  objectKey?: string;
  status: 'recording' | 'ready' | 'failed';
  durationMs?: number;
  sampleRate?: number;
  sizeBytes?: number;
}

/** Persist (or update) a session's recording metadata. */
export async function setSessionRecording(
  sessionId: string,
  update: SessionRecordingUpdate,
): Promise<void> {
  await pool.query(
    `UPDATE therapy_sessions
        SET recording_object_key = COALESCE($2, recording_object_key),
            recording_status      = $3,
            recording_duration_ms = COALESCE($4, recording_duration_ms),
            recording_sample_rate = COALESCE($5, recording_sample_rate),
            recording_size_bytes  = COALESCE($6, recording_size_bytes)
      WHERE session_id = $1`,
    [
      sessionId,
      update.objectKey ?? null,
      update.status,
      update.durationMs ?? null,
      update.sampleRate ?? null,
      update.sizeBytes ?? null,
    ],
  );
}

/**
 * Persist (or update) the participant-only track's metadata (migration 086).
 * Kept as an explicit second function rather than dynamic column names — two
 * tracks, two audited UPDATE statements.
 */
export async function setSessionParticipantRecording(
  sessionId: string,
  update: SessionRecordingUpdate,
): Promise<void> {
  await pool.query(
    `UPDATE therapy_sessions
        SET participant_recording_object_key = COALESCE($2, participant_recording_object_key),
            participant_recording_status      = $3,
            participant_recording_duration_ms = COALESCE($4, participant_recording_duration_ms),
            participant_recording_sample_rate = COALESCE($5, participant_recording_sample_rate),
            participant_recording_size_bytes  = COALESCE($6, participant_recording_size_bytes)
      WHERE session_id = $1`,
    [
      sessionId,
      update.objectKey ?? null,
      update.status,
      update.durationMs ?? null,
      update.sampleRate ?? null,
      update.sizeBytes ?? null,
    ],
  );
}

export interface SessionRecording {
  objectKey: string;
  status: string;
  durationMs: number | null;
  sizeBytes: number | null;
}

/** Fetch a session's recording metadata, or null if none stored. */
export async function getSessionRecording(
  sessionId: string,
): Promise<SessionRecording | null> {
  const res = await pool.query<{
    recording_object_key: string | null;
    recording_status: string | null;
    recording_duration_ms: number | null;
    recording_size_bytes: number | null;
  }>(
    `SELECT recording_object_key, recording_status,
            recording_duration_ms, recording_size_bytes
       FROM therapy_sessions
      WHERE session_id = $1`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row || !row.recording_object_key) return null;
  return {
    objectKey: row.recording_object_key,
    status: row.recording_status ?? 'unknown',
    durationMs: row.recording_duration_ms,
    sizeBytes: row.recording_size_bytes,
  };
}
