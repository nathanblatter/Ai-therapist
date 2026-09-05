-- Rollback for migration 091: drop the accountability tables.
BEGIN;
DROP TABLE IF EXISTS redaction_review_log;
DROP TABLE IF EXISTS data_access_log;
COMMIT;
