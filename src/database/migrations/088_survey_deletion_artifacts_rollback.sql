-- Rollback for 088.
ALTER TABLE data_deletion_log DROP CONSTRAINT data_deletion_log_artifact_type_check;
ALTER TABLE data_deletion_log ADD CONSTRAINT data_deletion_log_artifact_type_check
  CHECK (artifact_type IN ('recording_object', 'session_content', 'user_account'));
ALTER TABLE data_deletion_log DROP CONSTRAINT data_deletion_log_reason_check;
ALTER TABLE data_deletion_log ADD CONSTRAINT data_deletion_log_reason_check
  CHECK (reason IN ('recording_retention', 'wiped_user_grace', 'manual_admin'));
