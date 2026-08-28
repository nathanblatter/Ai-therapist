-- Rollback for migration 069: drop the organization layer.
-- Order matters: dependent columns first, then the table.

BEGIN;

ALTER TABLE client_invites DROP COLUMN IF EXISTS organization_id;
DROP INDEX IF EXISTS idx_users_org;
ALTER TABLE users DROP COLUMN IF EXISTS organization_id;
DROP TABLE IF EXISTS organizations;

COMMIT;
