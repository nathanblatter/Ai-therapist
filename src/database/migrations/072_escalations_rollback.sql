-- Rollback for migration 072: drop both escalation tables.

BEGIN;

DROP TABLE IF EXISTS escalation_events;
DROP TABLE IF EXISTS escalations;

COMMIT;
