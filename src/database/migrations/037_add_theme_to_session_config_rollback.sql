-- Rollback for 037_add_theme_to_session_config.sql
-- Drops the per-session UI theme column and its CHECK constraint.

ALTER TABLE session_configurations
  DROP CONSTRAINT IF EXISTS valid_theme,
  DROP COLUMN IF EXISTS theme;
