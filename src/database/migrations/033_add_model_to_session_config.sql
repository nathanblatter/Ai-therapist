-- Migration: Record the exact model strings used per session (ai-therapist-61)
-- Date: 2026-07-30
--
-- Research reproducibility: system_config holds floating aliases
-- (gpt-realtime-2.1 / gpt-realtime-2.1-mini, gpt-4o-*-transcribe) whose
-- underlying snapshot OpenAI can move under us. To be able to say exactly
-- which model produced a given session's transcript, the /token endpoint now
-- stamps the model strings onto session_configurations at session creation:
--
--   ai_model            - the realtime model requested for the session. If the
--                         OpenAI client_secrets response reports a resolved
--                         model (e.g. a dated snapshot), that value is stored
--                         instead of the alias.
--   transcription_model - the input-audio transcription model requested.
--
-- NULL on rows created before this migration (and on rows lazily created by
-- /logs/batch, where the model is unknown).

ALTER TABLE session_configurations
    ADD COLUMN IF NOT EXISTS ai_model TEXT,
    ADD COLUMN IF NOT EXISTS transcription_model TEXT;

COMMENT ON COLUMN session_configurations.ai_model IS
    'Exact realtime model string used for this session (resolved snapshot when OpenAI reports one, else the configured alias). NULL = unknown (pre-migration or lazily created).';
COMMENT ON COLUMN session_configurations.transcription_model IS
    'Exact input-audio transcription model string used for this session. NULL = unknown.';
