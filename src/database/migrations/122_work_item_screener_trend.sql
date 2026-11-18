-- 122: screener_trend work-item kind (idea ai-therapist-87, heuristic first step).
--
-- The daily work-queue sweep files a pool item for a client's care team when
-- the client's own PHQ-2 or GAD-2 answers cross the standard screening cutoff
-- (>= 3) from below, or rise across three consecutive administrations. It is a
-- descriptive self-report screening trend, not a risk prediction, and is
-- independent of crisis detection. Rules: src/server/utils/screenerTrend.ts.
-- Only the item_type CHECK changes; no new table.

BEGIN;

ALTER TABLE work_items DROP CONSTRAINT work_items_item_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_item_type_check CHECK (item_type IN (
  'crisis_flag', 'message_crisis', 'adverse_event', 'escalation_inbound',
  'escalation_response', 'note_awaiting_signature', 'inactivity',
  'screener_worsening', 'message_unread_stale',
  'survey_drift', 'participant_enrolled', 'participant_withdrawal',
  'screener_trend'
));

COMMIT;
