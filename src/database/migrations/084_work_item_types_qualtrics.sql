-- 084: two new work-item types for the Qualtrics integration (ai-therapist-149).
--   survey_drift         — a configured Qualtrics survey's question structure
--                          changed vs the stored hash (scoring/IRB-wording risk)
--   participant_enrolled — a new participant account was created via the
--                          baseline survey's /join-study link (onboarding cue)
ALTER TABLE work_items DROP CONSTRAINT work_items_item_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_item_type_check CHECK (item_type IN (
  'crisis_flag', 'message_crisis', 'adverse_event', 'escalation_inbound',
  'escalation_response', 'note_awaiting_signature', 'inactivity',
  'screener_worsening', 'message_unread_stale',
  'survey_drift', 'participant_enrolled'
));

-- Survey-reported adverse experiences become formal AE drafts too:
--   category 'survey_report', trigger_source 'auto_survey', no session —
--   session_ref carries 'qualtrics:<ResponseID>' instead.
ALTER TABLE adverse_event_reports DROP CONSTRAINT adverse_event_reports_category_check;
ALTER TABLE adverse_event_reports ADD CONSTRAINT adverse_event_reports_category_check
  CHECK (category IN ('crisis', 'eligibility_violation', 'survey_report'));
ALTER TABLE adverse_event_reports DROP CONSTRAINT adverse_event_reports_trigger_source_check;
ALTER TABLE adverse_event_reports ADD CONSTRAINT adverse_event_reports_trigger_source_check
  CHECK (trigger_source IN ('auto_crisis_flag', 'manual', 'auto_eligibility', 'auto_survey'));
-- One auto AE per survey response, so webhook + hourly sync overlap can't
-- double-file (mirrors the auto_eligibility per-session partial index).
CREATE UNIQUE INDEX ae_auto_survey_response ON adverse_event_reports (session_ref)
  WHERE trigger_source = 'auto_survey';
