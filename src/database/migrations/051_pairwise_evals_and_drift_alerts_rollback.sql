-- Rollback for 051_pairwise_evals_and_drift_alerts.sql
DROP TABLE IF EXISTS session_eval_pairs;
DROP TABLE IF EXISTS eval_drift_alerts;
