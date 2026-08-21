-- Rollback for migration 065: drop the client-invites table.

BEGIN;

DROP INDEX IF EXISTS idx_client_invites_therapist;
DROP TABLE IF EXISTS client_invites;

COMMIT;
