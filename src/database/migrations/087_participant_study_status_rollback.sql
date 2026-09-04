-- Rollback for 087.
BEGIN;

ALTER TABLE users
  DROP COLUMN IF EXISTS study_status,
  DROP COLUMN IF EXISTS study_status_changed_at,
  DROP COLUMN IF EXISTS study_status_source;

ALTER TABLE qualtrics_responses DROP CONSTRAINT qualtrics_responses_survey_role_check;
ALTER TABLE qualtrics_responses ADD CONSTRAINT qualtrics_responses_survey_role_check
  CHECK (survey_role IN ('baseline', 'weekly', 'exit', 'week12'));

ALTER TABLE work_items DROP CONSTRAINT work_items_item_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_item_type_check CHECK (item_type IN (
  'crisis_flag', 'message_crisis', 'adverse_event', 'escalation_inbound',
  'escalation_response', 'note_awaiting_signature', 'inactivity',
  'screener_worsening', 'message_unread_stale',
  'survey_drift', 'participant_enrolled'
));

COMMIT;
