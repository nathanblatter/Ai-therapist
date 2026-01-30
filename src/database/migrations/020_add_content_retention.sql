-- Migration: Add content retention settings and wipe log
-- Description: Track automated PII content wiping for IRB compliance
-- Date: 2026-01-29

-- Add content retention settings to system_config
INSERT INTO system_config (config_key, config_value, description) VALUES
(
    'content_retention',
    '{
        "enabled": true,
        "retention_hours": 24,
        "wipe_time": "03:00",
        "require_redaction_complete": true,
        "last_wipe_at": null,
        "last_wipe_count": 0
    }'::jsonb,
    'Content retention and automated PII wiping settings'
)
ON CONFLICT (config_key) DO NOTHING;

-- Create table to log content wipe operations for audit trail
CREATE TABLE IF NOT EXISTS content_wipe_log (
    wipe_id SERIAL PRIMARY KEY,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    messages_wiped INTEGER DEFAULT 0,
    messages_skipped INTEGER DEFAULT 0,
    status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    error_message TEXT,
    triggered_by VARCHAR(50) NOT NULL CHECK (triggered_by IN ('scheduler', 'manual')),
    triggered_by_user VARCHAR(255),
    retention_hours INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Create index for querying recent wipes
CREATE INDEX idx_content_wipe_log_started_at ON content_wipe_log(started_at DESC);

COMMENT ON TABLE content_wipe_log IS 'Audit log of all content wipe operations for IRB compliance';
COMMENT ON COLUMN content_wipe_log.messages_wiped IS 'Number of messages where original content was wiped';
COMMENT ON COLUMN content_wipe_log.messages_skipped IS 'Number of messages skipped (redaction incomplete or too recent)';
COMMENT ON COLUMN content_wipe_log.triggered_by IS 'Whether wipe was triggered by scheduler or manual admin action';
