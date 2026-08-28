-- Rollback 079: restore the original NO ACTION FKs from 073/076.

BEGIN;

ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_thread_message_id_fkey;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_thread_message_id_fkey
  FOREIGN KEY (thread_message_id) REFERENCES thread_messages(message_id);

ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_client_user_id_fkey;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_client_user_id_fkey
  FOREIGN KEY (client_user_id) REFERENCES users(userid);

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_acked_by_fkey;
ALTER TABLE work_items ADD CONSTRAINT work_items_acked_by_fkey
  FOREIGN KEY (acked_by) REFERENCES users(userid);

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_resolved_by_fkey;
ALTER TABLE work_items ADD CONSTRAINT work_items_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES users(userid);

COMMIT;
