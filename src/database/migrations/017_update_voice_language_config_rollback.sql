-- Rollback Migration 017: Revert voice and language configuration to simple array structure
-- This rollback restores the original simple array structure

-- Rollback voices config to simple array structure
UPDATE system_config
SET config_value = '{
  "enabled_voices": ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"],
  "default_voice": "cedar"
}'::jsonb
WHERE config_key = 'voices';

-- Rollback languages config to simple array structure
UPDATE system_config
SET config_value = '{
  "enabled_languages": ["en", "es-ES", "es-419", "fr-FR", "fr-CA", "pt-BR", "pt-PT", "de", "it", "zh", "ja", "ko", "ar", "hi", "ru"]
}'::jsonb
WHERE config_key = 'languages';
