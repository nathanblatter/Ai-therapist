-- Rollback for migration 059: drop the client error-beacon table.

BEGIN;

DROP INDEX IF EXISTS idx_client_events_kind_created;
DROP TABLE IF EXISTS client_events;

COMMIT;
