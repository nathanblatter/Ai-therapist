-- Caseworker-portal hardening: widen two audit-table CHECK constraints.
--
-- 1. caseload_audit_log.action (066): the work-queue routes now audit
--    ack/resolve ('work_item_ack', 'work_item_resolve') and the caseworker
--    AE filing route audits 'adverse_event_filed'. Until this lands those
--    inserts are rejected by the CHECK (insertCaseloadAudit logs and
--    swallows — non-fatal, but the audit row is dropped).
--
-- 2. data_deletion_log artifact_type/reason (053): the retention sweep now
--    hard-deletes aged thread messages and audits them as
--    artifact_type='thread_message', reason='message_retention'. The
--    deletion transaction is audited-or-rollback, so message age-out is
--    fail-closed until this lands (no unaudited deletion occurs).
BEGIN;

ALTER TABLE caseload_audit_log
  DROP CONSTRAINT IF EXISTS caseload_audit_log_action_check;
ALTER TABLE caseload_audit_log
  ADD CONSTRAINT caseload_audit_log_action_check CHECK (action IN (
    'assign', 'unassign', 'invite_created', 'invite_consumed',
    'work_item_ack', 'work_item_resolve', 'adverse_event_filed'));

ALTER TABLE data_deletion_log
  DROP CONSTRAINT IF EXISTS data_deletion_log_artifact_type_check;
ALTER TABLE data_deletion_log
  ADD CONSTRAINT data_deletion_log_artifact_type_check CHECK (artifact_type IN (
    'recording_object',      -- MinIO WAV deleted + recording_* columns nulled
    'session_content',       -- messages.content_redacted etc. hard-deleted
    'user_account',          -- wiped-user hard delete after grace
    'thread_message'         -- aged messaging-thread messages hard-deleted
  ));

ALTER TABLE data_deletion_log
  DROP CONSTRAINT IF EXISTS data_deletion_log_reason_check;
ALTER TABLE data_deletion_log
  ADD CONSTRAINT data_deletion_log_reason_check CHECK (reason IN (
    'recording_retention', 'wiped_user_grace', 'manual_admin',
    'message_retention'));

COMMIT;
