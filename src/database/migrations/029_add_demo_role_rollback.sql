-- Rollback: Demo (magic-link) accounts
-- Removes demo sessions/users first so the CHECK can be restored safely.

DELETE FROM therapy_sessions WHERE is_demo = true;
DELETE FROM users WHERE role = 'demo';

DROP INDEX IF EXISTS idx_sessions_is_demo;
ALTER TABLE therapy_sessions DROP COLUMN IF EXISTS is_demo;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('therapist', 'researcher', 'participant'));
