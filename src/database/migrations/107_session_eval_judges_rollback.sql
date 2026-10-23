-- Rollback for 107_session_eval_judges.sql
BEGIN;
ALTER TABLE session_evals DROP COLUMN IF EXISTS judge_spread;
DROP TABLE IF EXISTS session_eval_judges;
COMMIT;
