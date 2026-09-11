-- Rollback for 101_counterfactual_evals.sql
-- Drops the counterfactual comparison tables. No other feature reads them, so
-- this is safe at any time; only stored comparison results are lost.

DROP INDEX IF EXISTS idx_counterfactual_responses_run;
DROP TABLE IF EXISTS counterfactual_responses;

DROP INDEX IF EXISTS idx_counterfactual_runs_created;
DROP INDEX IF EXISTS idx_counterfactual_runs_session;
DROP TABLE IF EXISTS counterfactual_runs;
