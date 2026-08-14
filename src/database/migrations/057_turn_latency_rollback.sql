-- Rollback for 057_turn_latency.sql
DROP INDEX IF EXISTS idx_turn_latency_session;
DROP INDEX IF EXISTS idx_turn_latency_created;
DROP TABLE IF EXISTS turn_latency;
