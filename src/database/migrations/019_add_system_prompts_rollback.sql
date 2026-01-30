-- Rollback: Remove system_prompts configuration
-- Description: Deletes the system_prompts config key from system_config
-- Date: 2026-01-28

DELETE FROM system_config WHERE config_key = 'system_prompts';
