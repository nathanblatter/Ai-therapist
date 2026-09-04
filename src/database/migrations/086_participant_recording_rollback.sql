-- Rollback for 086.
ALTER TABLE therapy_sessions
  DROP COLUMN IF EXISTS participant_recording_object_key,
  DROP COLUMN IF EXISTS participant_recording_status,
  DROP COLUMN IF EXISTS participant_recording_duration_ms,
  DROP COLUMN IF EXISTS participant_recording_sample_rate,
  DROP COLUMN IF EXISTS participant_recording_size_bytes;
