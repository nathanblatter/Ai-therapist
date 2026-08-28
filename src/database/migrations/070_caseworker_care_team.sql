-- Migration 070: caseworker role + care-team evolution of therapist_clients
-- (caseworker portal foundation, docs/caseworker-portal.md).
-- Date: 2026-08-27

BEGIN;

-- New first-class role (same named-constraint dance as 029).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('therapist', 'researcher', 'participant', 'demo', 'caseworker'));

-- Care-team evolution: therapist_clients rows become care-team edges.
ALTER TABLE therapist_clients ADD COLUMN IF NOT EXISTS member_role TEXT
  NOT NULL DEFAULT 'therapist'
  CHECK (member_role IN ('therapist', 'caseworker'));
CREATE INDEX IF NOT EXISTS idx_therapist_clients_client_role
  ON therapist_clients(client_id, member_role);

COMMENT ON TABLE therapist_clients IS
  'Care-team membership: member (therapist_id column, historically named; holds therapist OR caseworker userid) -> client. member_role selects the data tier (therapist=full, caseworker=summaries+signals). docs/caseload-rbac.md';
COMMENT ON COLUMN therapist_clients.therapist_id IS
  'Care-team member userid (therapist or caseworker; legacy column name kept for deploy compatibility)';

COMMIT;
