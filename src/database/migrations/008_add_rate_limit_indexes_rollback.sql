-- Rollback for 008_add_rate_limit_indexes.sql
-- Drops the partial composite index used by the daily rate-limit count.
-- Safe at any point in the history: nothing later depends on this index.

DROP INDEX IF EXISTS idx_sessions_user_created;
