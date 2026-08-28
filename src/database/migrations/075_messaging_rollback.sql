-- Rollback for migration 075: drop the three messaging tables.

BEGIN;

DROP TABLE IF EXISTS thread_read_state;
DROP TABLE IF EXISTS thread_messages;
DROP TABLE IF EXISTS message_threads;

COMMIT;
