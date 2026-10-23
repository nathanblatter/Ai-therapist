-- Rollback for 021_add_composite_message_index.sql
-- Like the forward file this uses CONCURRENTLY, which cannot run inside a
-- transaction: apply it with psql (autocommit), not via runMigrationRange.js.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_session_created;
