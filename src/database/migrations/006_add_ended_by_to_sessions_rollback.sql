-- Rollback: Remove ended_by field from therapy_sessions
-- Date: 2026-01-02

ALTER TABLE therapy_sessions
DROP COLUMN IF EXISTS ended_by;
