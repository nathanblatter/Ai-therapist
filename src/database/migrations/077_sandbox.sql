-- Migration 077: sandbox denormalization + sandbox invites (caseworker portal,
-- docs/caseworker-portal.md sections 1 and 7).
-- Date: 2026-08-27

BEGIN;

-- Denormalized per-user flag so hot paths (crisis suppression, export WHEREs,
-- notification guard) never need the org join. Set at creation, never toggled.
-- Source of truth is organizations.kind='sandbox' (069).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_sandbox ON users(is_sandbox) WHERE is_sandbox;

CREATE TABLE IF NOT EXISTS sandbox_invites (
  invite_id    SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,                 -- sha256 hex, raw token never stored (065 pattern)
  batch_id     UUID NOT NULL,
  invite_role  TEXT NOT NULL CHECK (invite_role IN ('therapist','caseworker')),
  seed_profile TEXT NOT NULL DEFAULT 'standard',
  label        TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_by      INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  org_id       INTEGER REFERENCES organizations(org_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_invites_batch ON sandbox_invites(batch_id);

COMMENT ON TABLE sandbox_invites IS
  'One-time self-serve sandbox signup links; consuming one creates a fresh kind=sandbox org with a seeded synthetic caseload';

COMMIT;
