-- 088: deletion-request handling for withdrawal survey D4 (Qualtrics ops).
--
-- Participants who choose "please also delete my information where possible"
-- on the withdrawal survey get their Qualtrics survey responses deleted
-- (remote via the delete-response API, local answers blanked) by a
-- researcher-confirmed admin action. Each deleted artifact gets an audit row;
-- this adds the artifact type and the participant-request reason.

ALTER TABLE data_deletion_log DROP CONSTRAINT data_deletion_log_artifact_type_check;
ALTER TABLE data_deletion_log ADD CONSTRAINT data_deletion_log_artifact_type_check
  CHECK (artifact_type IN (
    'recording_object',
    'session_content',
    'user_account',
    'survey_response'        -- Qualtrics response deleted remotely + answers blanked locally
  ));

ALTER TABLE data_deletion_log DROP CONSTRAINT data_deletion_log_reason_check;
ALTER TABLE data_deletion_log ADD CONSTRAINT data_deletion_log_reason_check
  CHECK (reason IN (
    'recording_retention', 'wiped_user_grace', 'manual_admin',
    'participant_request'    -- withdrawal survey D4 deletion preference
  ));
