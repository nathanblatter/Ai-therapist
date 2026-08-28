-- Rollback for migration 077: drop sandbox_invites, drop users.is_sandbox.

BEGIN;

DROP TABLE IF EXISTS sandbox_invites;
DROP INDEX IF EXISTS idx_users_sandbox;
ALTER TABLE users DROP COLUMN IF EXISTS is_sandbox;

COMMIT;
