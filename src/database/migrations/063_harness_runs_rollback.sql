-- Rollback for 063: drop the simulation-eval run tables.
BEGIN;
DROP TABLE IF EXISTS harness_scenario_results;
DROP TABLE IF EXISTS harness_runs;
COMMIT;
