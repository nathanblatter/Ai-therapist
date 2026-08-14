-- Rollback for migration 061: drop the practice-assignments table.

BEGIN;

DROP INDEX IF EXISTS idx_practice_assignments_session;
DROP INDEX IF EXISTS idx_practice_assignments_user_status;
DROP TABLE IF EXISTS practice_assignments;

COMMIT;
