-- Rollback for 109_practice_assignments_clinician.sql
BEGIN;

-- Cancelled rows cannot survive the narrowed CHECK; fold them into 'skipped'.
UPDATE practice_assignments SET status = 'skipped' WHERE status = 'cancelled';

ALTER TABLE practice_assignments
  DROP CONSTRAINT IF EXISTS practice_assignments_status_check;
ALTER TABLE practice_assignments
  ADD CONSTRAINT practice_assignments_status_check
  CHECK (status IN ('assigned', 'completed', 'skipped'));

ALTER TABLE practice_assignments
  DROP COLUMN IF EXISTS reissued_from,
  DROP COLUMN IF EXISTS cancel_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS authored_by,
  DROP COLUMN IF EXISTS source;

DELETE FROM caseload_audit_log
 WHERE action IN ('assignment_created', 'assignment_updated', 'assignment_cancelled', 'assignment_reissued');

ALTER TABLE caseload_audit_log
  DROP CONSTRAINT IF EXISTS caseload_audit_log_action_check;
ALTER TABLE caseload_audit_log
  ADD CONSTRAINT caseload_audit_log_action_check CHECK (action IN (
    'assign', 'unassign', 'invite_created', 'invite_consumed',
    'work_item_ack', 'work_item_resolve', 'adverse_event_filed'));

COMMENT ON TABLE practice_assignments IS 'Between-session practice the AI assigned with the participant''s agreement (assign_practice tool)';
COMMENT ON COLUMN practice_assignments.status IS 'assigned | completed | skipped';

COMMIT;
