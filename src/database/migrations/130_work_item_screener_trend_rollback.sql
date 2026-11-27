-- Rollback for 130. screener_trend rows must go first or the narrowed CHECK
-- fails; they are derived from scale_responses and the next sweep after a
-- re-apply recreates any that are still current.
BEGIN;

DELETE FROM work_items WHERE item_type = 'screener_trend';

ALTER TABLE work_items DROP CONSTRAINT work_items_item_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_item_type_check CHECK (item_type IN (
  'crisis_flag', 'message_crisis', 'adverse_event', 'escalation_inbound',
  'escalation_response', 'note_awaiting_signature', 'inactivity',
  'screener_worsening', 'message_unread_stale',
  'survey_drift', 'participant_enrolled', 'participant_withdrawal'
));

COMMIT;
