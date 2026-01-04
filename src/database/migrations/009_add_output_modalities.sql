-- Migration: Add output_modalities to features config
-- Created: 2026-01-03
-- Description: Adds output modalities configuration to control AI response format (text, audio, or both)

-- Update the features config to include output_modalities
UPDATE system_config
SET config_value = jsonb_set(
    config_value,
    '{output_modalities}',
    '["audio"]'::jsonb
)
WHERE config_key = 'features';

-- Add description if needed
COMMENT ON COLUMN system_config.config_value IS 'JSON value for the configuration. Features config includes output_modalities: ["audio"], ["text"], or ["audio", "text"]';
