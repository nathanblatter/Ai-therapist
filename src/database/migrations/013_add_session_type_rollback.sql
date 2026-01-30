-- Rollback: Remove session_type column from therapy_sessions
-- Date: 2026-01-05

BEGIN;

-- Drop index
DROP INDEX IF EXISTS idx_sessions_session_type;

-- Remove session_type column
ALTER TABLE therapy_sessions
DROP COLUMN IF EXISTS session_type;

COMMIT;
