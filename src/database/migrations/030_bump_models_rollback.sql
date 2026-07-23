-- Rollback for 030_bump_models.sql
-- Restores the prior two-tier realtime values and removes the transcription
-- model config. (Input transcription falls back to the code default,
-- gpt-4o-mini-transcribe, if the app is newer than this rollback.)

UPDATE system_config
SET config_value = '{"model": "gpt-realtime-mini", "description": "Fast, cost-effective realtime model"}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE config_key = 'ai_model'
  AND config_value->>'model' = 'gpt-realtime-2.1-mini';

UPDATE system_config
SET config_value = '{"model": "gpt-realtime", "description": "Highest-quality realtime model"}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE config_key = 'ai_model'
  AND config_value->>'model' = 'gpt-realtime-2.1';

DELETE FROM system_config WHERE config_key = 'transcription_model';
