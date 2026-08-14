-- Rollback for 058_realtime_usage.sql
DROP INDEX IF EXISTS idx_realtime_usage_session;
DROP TABLE IF EXISTS realtime_usage;
