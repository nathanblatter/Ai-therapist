-- Migration 069: organizations (caseworker portal foundation, docs/caseworker-portal.md).
-- Date: 2026-08-27
--
-- Lightweight org layer (agency/practice/study). kind=research is the IRB
-- study; kind=sandbox orgs are demo-seeded and excluded from research and
-- crisis-paging pipelines. Every existing user backfills into the irb-study
-- org so researcher behavior at cutover is exactly today's.

BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
  org_id     SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'practice'
             CHECK (kind IN ('research', 'practice', 'sandbox')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE organizations IS
  'Lightweight org (agency/practice/study). kind=research is the IRB study; kind=sandbox orgs are demo-seeded and excluded from research & crisis paging pipelines.';

INSERT INTO organizations (slug, name, kind)
VALUES ('irb-study', 'IRB Research Study', 'research')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER
  REFERENCES organizations(org_id) ON DELETE RESTRICT;
UPDATE users SET organization_id =
  (SELECT org_id FROM organizations WHERE slug = 'irb-study')
WHERE organization_id IS NULL;
ALTER TABLE users ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

ALTER TABLE client_invites ADD COLUMN IF NOT EXISTS organization_id INTEGER
  REFERENCES organizations(org_id) ON DELETE CASCADE;
UPDATE client_invites ci SET organization_id = u.organization_id
  FROM users u WHERE u.userid = ci.therapist_id AND ci.organization_id IS NULL;
ALTER TABLE client_invites ALTER COLUMN organization_id SET NOT NULL;

COMMIT;
