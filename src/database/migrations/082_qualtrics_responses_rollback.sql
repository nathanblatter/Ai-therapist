-- Rollback for migration 082: synced Qualtrics survey responses.
BEGIN;

DROP TABLE IF EXISTS qualtrics_responses;

COMMIT;
