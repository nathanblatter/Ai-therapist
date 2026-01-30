-- Rollback: Remove AI model configuration
-- Description: Remove ai_model config from system_config table
-- Date: 2026-01-15

DELETE FROM system_config WHERE config_key = 'ai_model';
