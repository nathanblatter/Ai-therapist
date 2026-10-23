-- Migration 109: clinician-authored practice assignments (ai-therapist-200).
-- Date: 2026-10-22
--
-- practice_assignments (061) had exactly one writer, the AI's assign_practice
-- tool. Therapists and researchers can now create, edit, cancel and re-issue
-- assignments from the participant profile, so the row needs to say who
-- wrote it and why it went away:
--   source        'ai' (existing rows, assign_practice) | 'therapist'
--   authored_by   the clinician's userid for source='therapist' (NULL for AI)
--   status        gains 'cancelled' (cancellation never deletes)
--   cancelled_at / cancelled_by / cancel_reason
--   reissued_from the assignment this one re-issues (chain, never a copy loss)
-- caseload_audit_log.action gains the four assignment write actions so every
-- clinician write lands in the existing audit table (no new table).

BEGIN;

ALTER TABLE practice_assignments
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ai'
    CHECK (source IN ('ai', 'therapist')),
  ADD COLUMN IF NOT EXISTS authored_by INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS reissued_from BIGINT REFERENCES practice_assignments(id) ON DELETE SET NULL;

ALTER TABLE practice_assignments
  DROP CONSTRAINT IF EXISTS practice_assignments_status_check;
ALTER TABLE practice_assignments
  ADD CONSTRAINT practice_assignments_status_check
  CHECK (status IN ('assigned', 'completed', 'skipped', 'cancelled'));

ALTER TABLE caseload_audit_log
  DROP CONSTRAINT IF EXISTS caseload_audit_log_action_check;
ALTER TABLE caseload_audit_log
  ADD CONSTRAINT caseload_audit_log_action_check CHECK (action IN (
    'assign', 'unassign', 'invite_created', 'invite_consumed',
    'work_item_ack', 'work_item_resolve', 'adverse_event_filed',
    'assignment_created', 'assignment_updated', 'assignment_cancelled', 'assignment_reissued'));

COMMENT ON TABLE practice_assignments IS 'Between-session practice assigned by the AI (assign_practice tool, source=ai) or by a clinician from the participant profile (source=therapist)';
COMMENT ON COLUMN practice_assignments.source IS 'ai | therapist';
COMMENT ON COLUMN practice_assignments.status IS 'assigned | completed | skipped | cancelled';
COMMENT ON COLUMN practice_assignments.cancel_reason IS 'Clinician-facing reason recorded on cancel; never shown to the participant';
COMMENT ON COLUMN practice_assignments.reissued_from IS 'The earlier assignment this row re-issues (migration 109)';

COMMIT;
