// Derived acoustic-feature storage (migration 095, Phase 2 telemetry).
// Rows hold only derived numeric measures computed by
// acousticFeatures.service — never audio, never transcript content.
import { pool } from '../config/db.js';

export interface ParticipantRecordingInfo {
  objectKey: string | null;
  status: string | null;
  sampleRate: number | null;
}

/** Participant-track recording pointers for one session. */
export async function getParticipantRecordingForSession(
  sessionId: string
): Promise<ParticipantRecordingInfo | null> {
  const result = await pool.query(
    `SELECT participant_recording_object_key AS object_key,
            participant_recording_status      AS status,
            participant_recording_sample_rate AS sample_rate
     FROM therapy_sessions
     WHERE session_id = $1`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    objectKey: row.object_key ?? null,
    status: row.status ?? null,
    sampleRate: row.sample_rate ?? null,
  };
}

/** Upsert the derived features (or a failure marker) for one session. */
export async function upsertSessionAcousticFeatures(
  sessionId: string,
  status: 'complete' | 'failed',
  features: Record<string, unknown> | null
): Promise<void> {
  await pool.query(
    `INSERT INTO session_acoustic_features (session_id, status, features, computed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (session_id)
     DO UPDATE SET status = $2, features = $3, computed_at = NOW()`,
    [sessionId, status, features ? JSON.stringify(features) : null]
  );
}
