-- Migration: Add audio recording metadata to sessions
-- Description: Store the object-storage key and metadata for the mixed
--              (mic + assistant) audio recording captured during a session.
-- Date: 2026-06-27

ALTER TABLE therapy_sessions
  ADD COLUMN IF NOT EXISTS recording_object_key  TEXT,
  ADD COLUMN IF NOT EXISTS recording_status      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS recording_duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS recording_sample_rate INTEGER,
  ADD COLUMN IF NOT EXISTS recording_size_bytes  BIGINT;

COMMENT ON COLUMN therapy_sessions.recording_object_key IS 'Object-storage key (bucket-relative) of the WAV recording, e.g. sessions/{id}/recording.wav';
COMMENT ON COLUMN therapy_sessions.recording_status IS 'recording | ready | failed';
COMMENT ON COLUMN therapy_sessions.recording_duration_ms IS 'Recording length in milliseconds';
COMMENT ON COLUMN therapy_sessions.recording_sample_rate IS 'PCM sample rate of the stored WAV';
COMMENT ON COLUMN therapy_sessions.recording_size_bytes IS 'Size of the stored WAV file in bytes';
