-- Migration: Create system_config table
-- Description: Store system-wide configuration settings
-- Date: 2026-01-02

CREATE TABLE IF NOT EXISTS system_config (
    config_id SERIAL PRIMARY KEY,
    config_key VARCHAR(255) UNIQUE NOT NULL,
    config_value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(255)
);

-- Create index on config_key for fast lookups
CREATE INDEX idx_system_config_key ON system_config(config_key);

COMMENT ON TABLE system_config IS 'System-wide configuration settings';
COMMENT ON COLUMN system_config.config_key IS 'Unique key for the configuration setting';
COMMENT ON COLUMN system_config.config_value IS 'JSON value for the configuration';
COMMENT ON COLUMN system_config.updated_by IS 'Username of admin who last updated this config';

-- Insert default configuration values
INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'crisis_contact',
    '{"hotline": "BYU Counseling and Psychological Services", "phone": "(801) 422-3035", "text": "HELLO to 741741", "enabled": true}'::jsonb,
    'Crisis contact information displayed to users'
),
(
    'session_limits',
    '{"max_duration_minutes": 60, "max_sessions_per_day": 3, "cooldown_minutes": 30, "enabled": false}'::jsonb,
    'Session duration and frequency limits'
),
(
    'features',
    '{"voice_enabled": true, "chat_enabled": true, "file_upload_enabled": false, "session_recording_enabled": false}'::jsonb,
    'Feature flags to enable/disable functionality'
),
(
    'languages',
    '{"enabled_languages": ["en", "es-ES", "es-419", "fr-FR", "fr-CA", "pt-BR", "pt-PT", "de", "it", "zh", "ja", "ko", "ar", "hi", "ru"]}'::jsonb,
    'Available language options'
),
(
    'voices',
    '{"enabled_voices": ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"], "default_voice": "cedar"}'::jsonb,
    'Available voice options'
)
ON CONFLICT (config_key) DO NOTHING;
