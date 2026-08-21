BEGIN;
ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_trigger_method_check;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_trigger_method_check
  CHECK (trigger_method IN ('auto', 'manual', 'system'));
COMMIT;
