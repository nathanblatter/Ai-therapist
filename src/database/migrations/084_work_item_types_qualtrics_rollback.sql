-- Rollback 084: restore the pre-Qualtrics item_type list. Fails if any
-- survey_drift/participant_enrolled rows exist — delete them first.
ALTER TABLE work_items DROP CONSTRAINT work_items_item_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_item_type_check CHECK (item_type IN (
  'crisis_flag', 'message_crisis', 'adverse_event', 'escalation_inbound',
  'escalation_response', 'note_awaiting_signature', 'inactivity',
  'screener_worsening', 'message_unread_stale'
));

DROP INDEX IF EXISTS ae_auto_survey_response;
ALTER TABLE adverse_event_reports DROP CONSTRAINT adverse_event_reports_category_check;
ALTER TABLE adverse_event_reports ADD CONSTRAINT adverse_event_reports_category_check
  CHECK (category IN ('crisis', 'eligibility_violation'));
ALTER TABLE adverse_event_reports DROP CONSTRAINT adverse_event_reports_trigger_source_check;
ALTER TABLE adverse_event_reports ADD CONSTRAINT adverse_event_reports_trigger_source_check
  CHECK (trigger_source IN ('auto_crisis_flag', 'manual', 'auto_eligibility'));
