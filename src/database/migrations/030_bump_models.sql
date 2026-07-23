-- Migration: Bump to latest Realtime models + add configurable transcription model
-- Date: 2026-07-22
--
-- Realtime: the two-tier selection moves to the latest generation, preserving
-- whichever cost tier was already chosen:
--   gpt-realtime-mini  -> gpt-realtime-2.1-mini  (cheap)
--   gpt-realtime       -> gpt-realtime-2.1       (good/expensive)
-- Only known legacy values are rewritten, so a deliberately-pinned custom model
-- is left untouched.
--
-- Transcription: input-audio transcription (which feeds the crisis keyword
-- screen and the redaction pipeline) was previously hard-coded to whisper-1.
-- It becomes a first-class system_config entry with the same two-tier shape,
-- defaulting to the latest cost-effective model.

UPDATE system_config
SET config_value = '{"model": "gpt-realtime-2.1-mini", "description": "Latest cost-effective realtime model"}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE config_key = 'ai_model'
  AND config_value->>'model' IN (
    'gpt-realtime-mini',
    'gpt-4o-realtime-preview',
    'gpt-4o-mini-realtime-preview'
  );

UPDATE system_config
SET config_value = '{"model": "gpt-realtime-2.1", "description": "Latest highest-quality realtime model"}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE config_key = 'ai_model'
  AND config_value->>'model' = 'gpt-realtime';

INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'transcription_model',
    '{"model": "gpt-4o-mini-transcribe", "description": "Latest cost-effective transcription model"}'::jsonb,
    'Model used to transcribe participant audio in realtime sessions'
)
ON CONFLICT (config_key) DO NOTHING;
