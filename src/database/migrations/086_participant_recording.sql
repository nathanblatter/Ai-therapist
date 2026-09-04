-- 086: participant-only recording track (Phase 2 prosody research).
--
-- The existing recording (022) is a browser-side MONO MIX of mic + assistant,
-- which permanently confounds participant acoustics with assistant audio. The
-- client now also uploads a second, mic-only track (pre-gain tap); the server
-- stores it beside the mix as sessions/<id>/participant.wav. Columns mirror
-- 022. Consent: the participant track is a subset of audio already recorded
-- in the mix, gated by the same session_recording_enabled feature flag and
-- participant_consents.recording_enabled snapshot. Retention: aged out by the
-- same recordings_retention_days pass as the mixed track.

ALTER TABLE therapy_sessions
  ADD COLUMN participant_recording_object_key TEXT,
  ADD COLUMN participant_recording_status VARCHAR(20),
  ADD COLUMN participant_recording_duration_ms INTEGER,
  ADD COLUMN participant_recording_sample_rate INTEGER,
  ADD COLUMN participant_recording_size_bytes BIGINT;
