-- Migration 079: ON DELETE behavior for the FKs added by 073/076 (adversarial
-- review of the caseworker portal). Pre-portal, DELETE FROM users always
-- succeeded (therapy_sessions.user_id is ON DELETE SET NULL); the new
-- NO ACTION FKs broke that:
--   - crisis_events.thread_message_id / client_user_id blocked deleting any
--     participant with a flagged thread message (and 070's rollback path);
--     both become ON DELETE CASCADE — the origin-consistency CHECK requires
--     both columns NOT NULL for origin='thread_message', so SET NULL is not
--     an option, and the flagged message itself is cascaded away with the
--     user anyway (message_threads -> thread_messages).
--   - work_items.acked_by / resolved_by blocked deleting a clinician who ever
--     acked/resolved an item; both become ON DELETE SET NULL, matching
--     escalations.acknowledged_by/resolved_by (072).
-- Date: 2026-08-27

BEGIN;

ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_thread_message_id_fkey;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_thread_message_id_fkey
  FOREIGN KEY (thread_message_id) REFERENCES thread_messages(message_id) ON DELETE CASCADE;

ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_client_user_id_fkey;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_client_user_id_fkey
  FOREIGN KEY (client_user_id) REFERENCES users(userid) ON DELETE CASCADE;

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_acked_by_fkey;
ALTER TABLE work_items ADD CONSTRAINT work_items_acked_by_fkey
  FOREIGN KEY (acked_by) REFERENCES users(userid) ON DELETE SET NULL;

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_resolved_by_fkey;
ALTER TABLE work_items ADD CONSTRAINT work_items_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES users(userid) ON DELETE SET NULL;

COMMIT;
