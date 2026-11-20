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
export async function setSessionRecording(sessionId: string, update: SessionRecordingUpdate): Promise<void> {
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
export async function setSessionParticipantRecording(sessionId: string, update: SessionRecordingUpdate): Promise<void> {
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

export interface ParticipantAudioProblemDetails {
  problem: 'missing' | 'short' | 'silent';
  mixedMs: number;
  wallMs: number;
  participantMs: number;
  participantUnmutedMs: number;
  participantRmsDbfs: number | null;
  participantGapChunks: number;
  /** Silence inserted in participant.wav for lost audio (ai-therapist-384). */
  participantInsertedSilenceMs?: number;
}

const PARTICIPANT_AUDIO_DESCRIPTION: Record<ParticipantAudioProblemDetails['problem'], string> = {
  missing: 'Voice session ended with no participant audio track (participant.wav not stored)',
  short: 'Voice session ended with a participant audio track much shorter than the session recording',
  silent: 'Voice session ended with a silent participant audio track',
};

/**
 * Put a voice session that ended without usable participant audio on the
 * Study Ops deviation list (ai-therapist-372), so staff see it instead of
 * finding out at analysis time. Uses the existing protocol_deviations log as
 * an auto row (category technical_failure, deduplicated per session by
 * auto_key); demo and harness sessions are left out like every other auto
 * flag. Returns whether a new row was added. Called only when
 * features.participant_audio_auto_deviation is on (default off; see
 * recorder.service.ts).
 */
export async function flagParticipantAudioProblem(
  sessionId: string,
  details: ParticipantAudioProblemDetails,
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO protocol_deviations
            (source, category, severity, session_id, description, details, auto_key, created_by)
     SELECT 'auto', 'technical_failure', 'minor', ts.session_id, $2, $3::jsonb, $4, 'system'
       FROM therapy_sessions ts
      WHERE ts.session_id = $1 AND ts.is_demo IS NOT TRUE
     ON CONFLICT (auto_key) DO NOTHING`,
    [
      sessionId,
      PARTICIPANT_AUDIO_DESCRIPTION[details.problem],
      JSON.stringify(details),
      `participant_audio:${sessionId}`,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Fetch a session's recording metadata, or null if none stored. */
export async function getSessionRecording(sessionId: string): Promise<SessionRecording | null> {
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
