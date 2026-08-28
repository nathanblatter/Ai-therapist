-- Rollback for 080: restore the original CHECK value sets from 066 and 053.
-- NOTE: fails if rows with the new values exist; delete or rewrite those
-- audit rows first (they are append-only by policy, so prefer roll-forward).
BEGIN;

ALTER TABLE caseload_audit_log
  DROP CONSTRAINT IF EXISTS caseload_audit_log_action_check;
ALTER TABLE caseload_audit_log
  ADD CONSTRAINT caseload_audit_log_action_check CHECK (action IN (
    'assign', 'unassign', 'invite_created', 'invite_consumed'));

ALTER TABLE data_deletion_log
  DROP CONSTRAINT IF EXISTS data_deletion_log_artifact_type_check;
ALTER TABLE data_deletion_log
  ADD CONSTRAINT data_deletion_log_artifact_type_check CHECK (artifact_type IN (
    'recording_object', 'session_content', 'user_account'));

ALTER TABLE data_deletion_log
  DROP CONSTRAINT IF EXISTS data_deletion_log_reason_check;
ALTER TABLE data_deletion_log
  ADD CONSTRAINT data_deletion_log_reason_check CHECK (reason IN (
    'recording_retention', 'wiped_user_grace', 'manual_admin'));

COMMIT;
