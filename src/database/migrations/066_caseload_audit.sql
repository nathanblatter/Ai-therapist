-- Caseload audit trail (docs/caseload-rbac.md, HIPAA posture: access-control
-- changes must be auditable). Append-only, mirroring data_deletion_log's
-- per-domain pattern. No FK cascades: audit rows must survive account deletion.
BEGIN;

CREATE TABLE IF NOT EXISTS caseload_audit_log (
  audit_id       SERIAL PRIMARY KEY,
  action         TEXT NOT NULL CHECK (action IN ('assign', 'unassign', 'invite_created', 'invite_consumed')),
  therapist_id   INTEGER,
  client_id      INTEGER,
  actor_user_id  INTEGER,
  actor_username TEXT,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caseload_audit_created ON caseload_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_caseload_audit_therapist ON caseload_audit_log (therapist_id);

COMMENT ON TABLE caseload_audit_log IS 'Append-only audit of caseload assignment and invite events (who granted whom access to which client, when).';

COMMIT;
