-- Rollback for 126_config_evaluations.sql
-- Drops the evaluation record. The admin drift notice then reports every
-- configuration as unevaluated (the status route treats a missing table as
-- "no evaluations"), and the redteam-config workflow's claim calls fail until
-- the migration is re-applied. The underlying CI runs and their artifacts are
-- unaffected; rows can be re-created by re-running the workflow.
BEGIN;

DROP INDEX IF EXISTS idx_config_evaluations_started;
DROP INDEX IF EXISTS idx_config_evaluations_fingerprint;
DROP TABLE IF EXISTS config_evaluations;

COMMIT;
