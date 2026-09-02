-- Rollback for migration 081: Qualtrics baseline-survey signup links.
BEGIN;

DROP TABLE IF EXISTS qualtrics_signups;

COMMIT;
