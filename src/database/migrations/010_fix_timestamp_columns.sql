-- Migration: Fix timestamp columns to use TIMESTAMPTZ
-- Created: 2026-01-03
-- Description: Convert TIMESTAMP columns to TIMESTAMPTZ to properly handle timezones

-- Fix therapy_sessions table
ALTER TABLE therapy_sessions
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN ended_at TYPE TIMESTAMPTZ USING ended_at AT TIME ZONE 'UTC';

-- Fix messages table
ALTER TABLE messages
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- Fix users table
ALTER TABLE users
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';

-- Fix conversation_logs table
ALTER TABLE conversation_logs
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- Fix system_config table
ALTER TABLE system_config
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';

-- Update default values to use TIMESTAMPTZ
ALTER TABLE therapy_sessions
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE messages
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE users
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE conversation_logs
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE system_config
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

COMMENT ON COLUMN therapy_sessions.created_at IS 'Session creation timestamp in UTC';
COMMENT ON COLUMN therapy_sessions.updated_at IS 'Last update timestamp in UTC';
COMMENT ON COLUMN therapy_sessions.ended_at IS 'Session end timestamp in UTC';
