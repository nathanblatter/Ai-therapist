-- Rollback for migration 070: remove the caseworker role + care-team column.
-- Mirrors 029's rollback: caseworker users/rows are removed first so the
-- 4-role CHECK can be restored safely.

BEGIN;

DELETE FROM therapist_clients WHERE member_role = 'caseworker';
DELETE FROM users WHERE role = 'caseworker';

DROP INDEX IF EXISTS idx_therapist_clients_client_role;
ALTER TABLE therapist_clients DROP COLUMN IF EXISTS member_role;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('therapist', 'researcher', 'participant', 'demo'));

COMMENT ON TABLE therapist_clients IS
  'Therapist -> client (participant) caseload assignments; row-scopes therapist access (docs/caseload-rbac.md)';

COMMIT;
