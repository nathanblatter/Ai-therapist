-- Synthetic audit provenance for migration 064's backfill assignments
-- (red-team finding F5): the audit trail's purpose is "who granted whom
-- access, when" — the initial cross-join grants had no rows. One synthetic
-- 'assign' row per assignment that predates the audit table and has no
-- recorded grant. Idempotent via the NOT EXISTS guard.
BEGIN;

INSERT INTO caseload_audit_log (action, therapist_id, client_id, actor_user_id, actor_username, detail, created_at)
SELECT 'assign', tc.therapist_id, tc.client_id, NULL, NULL,
       jsonb_build_object('source', 'migration_064_backfill'),
       tc.assigned_at
FROM therapist_clients tc
WHERE NOT EXISTS (
  SELECT 1 FROM caseload_audit_log al
  WHERE al.action = 'assign'
    AND al.therapist_id = tc.therapist_id
    AND al.client_id = tc.client_id
);

COMMIT;
