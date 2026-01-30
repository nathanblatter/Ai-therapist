-- Migration: Add AI model configuration
-- Description: Add ai_model config to system_config table
-- Date: 2026-01-15

INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'ai_model',
    '{"model": "gpt-realtime-mini", "description": "Fast, cost-effective realtime model"}'::jsonb,
    'AI model used for all therapy sessions'
)
ON CONFLICT (config_key) DO NOTHING;
