-- Rollback for migration 097: revert transcription model migration.

BEGIN;

UPDATE system_config
SET config_value = jsonb_set(config_value, '{model}', '"gpt-4o-mini-transcribe"')
WHERE config_key = 'transcription_model'
  AND config_value->>'model' = 'gpt-transcribe';

DELETE FROM system_config WHERE config_key = 'transcription_context';

COMMIT;
