-- Rollback for migration 064: drop the therapist caseload table.

BEGIN;

DROP INDEX IF EXISTS idx_therapist_clients_client;
DROP TABLE IF EXISTS therapist_clients;

COMMIT;
