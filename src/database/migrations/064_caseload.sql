-- Migration 064: therapist caseload assignments (ai-therapist-119, therapist-pilot blocker #1).
-- Date: 2026-08-21
--
-- Backs row-scoped RBAC for therapist accounts: a therapist may only see
-- participants they are assigned to (see docs/caseload-rbac.md). Researchers
-- stay unscoped. The backfill assigns every existing participant to every
-- existing therapist so current research-deployment behavior is exactly
-- preserved at cutover; post-cutover assignments are explicit only.

BEGIN;

CREATE TABLE IF NOT EXISTS therapist_clients (
  therapist_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  client_id    INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  assigned_by  INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (therapist_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_therapist_clients_client ON therapist_clients(client_id);

-- Backfill: all existing participants -> all existing therapists.
INSERT INTO therapist_clients (therapist_id, client_id)
SELECT t.userid, p.userid FROM users t CROSS JOIN users p
WHERE t.role = 'therapist' AND p.role = 'participant'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE therapist_clients IS 'Therapist -> client (participant) caseload assignments; row-scopes therapist access (docs/caseload-rbac.md)';
COMMENT ON COLUMN therapist_clients.assigned_by IS 'User who made the assignment (researcher or invite flow); null after that user is deleted';

COMMIT;
