-- 106_squawk_ids.sql — link local accounts and organisations to Squawk
-- (auth-service-33). Sign-in moves to Squawk (Nathan's auth service); the
-- app keeps its users table for RBAC and foreign keys and remembers each
-- row's Squawk id. Filled by src/database/scripts/importToSquawk.ts for
-- existing rows and by accounts.service.ts for new ones. The password
-- column stays for now (legacy login when Squawk is not configured).

ALTER TABLE users ADD COLUMN IF NOT EXISTS squawk_user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_squawk_user_id ON users (squawk_user_id) WHERE squawk_user_id IS NOT NULL;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS squawk_org_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_squawk_org_id ON organizations (squawk_org_id) WHERE squawk_org_id IS NOT NULL;
