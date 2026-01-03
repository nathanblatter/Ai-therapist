-- Rollback Migration 005: Remove language column from session_configurations

ALTER TABLE session_configurations
DROP COLUMN IF EXISTS language;
