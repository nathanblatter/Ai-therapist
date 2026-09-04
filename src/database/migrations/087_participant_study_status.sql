-- 087: participant study status + withdrawal survey wiring (Phase 2).
--
-- Participants can pause or withdraw via a dedicated Qualtrics withdrawal
-- survey (role 'withdrawal', linked from the participant Profile page). The
-- sync pipeline resolves the response to an account and stamps study_status
-- here; withdrawn/paused participants are blocked from starting new sessions
-- and surfaced to the coordinator via a participant_withdrawal work item.

BEGIN;

ALTER TABLE users
  ADD COLUMN study_status TEXT NOT NULL DEFAULT 'active'
    CHECK (study_status IN ('active', 'paused', 'withdrawn')),
  ADD COLUMN study_status_changed_at TIMESTAMPTZ,
  ADD COLUMN study_status_source TEXT;  -- 'qualtrics:<ResponseID>' | 'admin:<username>'

-- 5th survey role for the withdrawal micro-survey.
ALTER TABLE qualtrics_responses DROP CONSTRAINT qualtrics_responses_survey_role_check;
ALTER TABLE qualtrics_responses ADD CONSTRAINT qualtrics_responses_survey_role_check
  CHECK (survey_role IN ('baseline', 'weekly', 'exit', 'week12', 'withdrawal'));

-- Coordinator cue when a participant withdraws or pauses.
ALTER TABLE work_items DROP CONSTRAINT work_items_item_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_item_type_check CHECK (item_type IN (
  'crisis_flag', 'message_crisis', 'adverse_event', 'escalation_inbound',
  'escalation_response', 'note_awaiting_signature', 'inactivity',
  'screener_worsening', 'message_unread_stale',
  'survey_drift', 'participant_enrolled', 'participant_withdrawal'
));

COMMIT;
