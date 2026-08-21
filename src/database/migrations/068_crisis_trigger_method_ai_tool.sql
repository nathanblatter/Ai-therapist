-- escalate_to_human (toolRegistry.service.ts) records crisis_events with
-- trigger_method='ai_tool', but migration 011's CHECK only allows
-- auto/manual/system — every AI-initiated escalation insert has been failing.
-- Surfaced by the red-team smoke's crisis ladder (2026-08-21).
BEGIN;

ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_trigger_method_check;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_trigger_method_check
  CHECK (trigger_method IN ('auto', 'manual', 'system', 'ai_tool'));

COMMIT;
