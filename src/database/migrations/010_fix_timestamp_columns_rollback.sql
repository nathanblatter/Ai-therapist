-- Rollback for 010_fix_timestamp_columns.sql
-- Converts the five tables' timestamp columns back from TIMESTAMPTZ to
-- TIMESTAMP (UTC wall-clock, the pre-010 representation). Lossless in both
-- directions because 010 interpreted the old values as UTC.
--
-- Ordering notes (rollbacks run in reverse migration order):
--   * 095 creates the view participant_session_rhythm over
--     therapy_sessions.created_at/ended_at; ALTER COLUMN TYPE fails while that
--     view exists, so apply 095_phase2_telemetry_rollback.sql first.
--   * conversation_logs is dropped by 036. The block below only touches it if
--     it still exists, so this file works both before and after 036.
--   * 010 itself ALTERs conversation_logs unconditionally, so re-applying the
--     forward file after 036 needs the stub table that
--     scripts/redteam-db-setup.sh creates (see docs/db.md).

ALTER TABLE therapy_sessions
  ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN ended_at   TYPE TIMESTAMP USING ended_at   AT TIME ZONE 'UTC';

ALTER TABLE messages
  ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC';

ALTER TABLE users
  ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at AT TIME ZONE 'UTC';

DO $$
BEGIN
  IF to_regclass('public.conversation_logs') IS NOT NULL THEN
    ALTER TABLE conversation_logs
      ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC';
    ALTER TABLE conversation_logs
      ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

ALTER TABLE system_config
  ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at AT TIME ZONE 'UTC';

-- Re-state the defaults (CURRENT_TIMESTAMP is cast to the new column type).
ALTER TABLE therapy_sessions
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE messages
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE users
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE system_config
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

-- 010 added these comments; the columns had none before it.
COMMENT ON COLUMN therapy_sessions.created_at IS NULL;
COMMENT ON COLUMN therapy_sessions.updated_at IS NULL;
COMMENT ON COLUMN therapy_sessions.ended_at IS NULL;
