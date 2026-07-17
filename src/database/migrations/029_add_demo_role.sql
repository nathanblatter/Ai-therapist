-- Migration: Demo (magic-link) accounts
-- Description: Adds a 'demo' role for auto-provisioned resume/magic-link visitors
-- and an is_demo flag on therapy_sessions so demo activity can be excluded from
-- the real crisis-alert pipeline and research data.

-- 1. Allow the 'demo' role. The original CHECK from 001 is the unnamed
--    (auto-named) constraint users_role_check.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('therapist', 'researcher', 'participant', 'demo'));

-- 2. Mark sessions created by demo visitors. Real participant sessions default
--    to false; demo sessions are set true at creation time.
ALTER TABLE therapy_sessions
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sessions_is_demo ON therapy_sessions(is_demo);

COMMENT ON COLUMN therapy_sessions.is_demo IS 'True for sessions started by a magic-link demo account; excluded from crisis alerting and research data.';
