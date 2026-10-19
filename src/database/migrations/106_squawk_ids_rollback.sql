-- Rollback for 106_squawk_ids.sql. The Squawk accounts themselves are not
-- touched; delete them in the Squawk console if the migration is abandoned.

DROP INDEX IF EXISTS idx_organizations_squawk_org_id;
ALTER TABLE organizations DROP COLUMN IF EXISTS squawk_org_id;
DROP INDEX IF EXISTS idx_users_squawk_user_id;
ALTER TABLE users DROP COLUMN IF EXISTS squawk_user_id;
