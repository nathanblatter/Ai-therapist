-- Rollback for 022_add_session_recording.sql
-- Drops the mixed-track recording metadata columns. The WAV objects stay in
-- object storage but become unreachable (recording_object_key is the only
-- pointer), and the recordings_retention_days pass will no longer age them
-- out. Back up first; this is the same shape as 086's rollback for the
-- participant-only track, which is independent of these columns.

ALTER TABLE therapy_sessions
  DROP COLUMN IF EXISTS recording_object_key,
  DROP COLUMN IF EXISTS recording_status,
  DROP COLUMN IF EXISTS recording_duration_ms,
  DROP COLUMN IF EXISTS recording_sample_rate,
  DROP COLUMN IF EXISTS recording_size_bytes;
