-- Rollback for migration 076: remove message-origin support from
-- crisis_events. Requires no thread-origin rows remain, so they are deleted
-- first (they cannot be represented under the restored NOT NULL).

BEGIN;

DELETE FROM crisis_events WHERE origin = 'thread_message';

DROP INDEX IF EXISTS idx_crisis_events_client;
ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_origin_consistency_check;
ALTER TABLE crisis_events DROP COLUMN IF EXISTS client_user_id;
ALTER TABLE crisis_events DROP COLUMN IF EXISTS thread_message_id;
ALTER TABLE crisis_events DROP COLUMN IF EXISTS origin;
ALTER TABLE crisis_events ALTER COLUMN session_id SET NOT NULL;

COMMIT;
