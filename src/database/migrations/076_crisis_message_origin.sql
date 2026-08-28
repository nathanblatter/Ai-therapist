-- Migration 076: widen crisis_events (068 pattern) so message-scan flags share
-- the crisis audit trail (caseworker portal, docs/caseworker-portal.md C12).
-- Riskiest migration of the set: integration runs a grep audit of every
-- consumer assuming session_id IS NOT NULL before this ships.
-- Message flags use trigger_method='auto', triggered_by='system',
-- event_type='flagged'; risk_score_history is NOT written for message scans.
-- Date: 2026-08-27
--
-- Note: constraint names deviate from the spec draft's single
-- crisis_events_origin_check because Postgres auto-names the inline column
-- CHECK on origin as crisis_events_origin_check; two explicit names avoid the
-- collision.

BEGIN;

ALTER TABLE crisis_events ALTER COLUMN session_id DROP NOT NULL;

-- Idempotency: the CHECK is (re-)added as a standalone constraint AFTER the
-- column add. Attaching it inline to ADD COLUMN IF NOT EXISTS would silently
-- drop it on re-run (the DROP fires unconditionally, but the inline ADD is
-- skipped once the column exists).
ALTER TABLE crisis_events ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'session';
ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_origin_value_check;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_origin_value_check CHECK (origin IN ('session','thread_message'));

ALTER TABLE crisis_events ADD COLUMN IF NOT EXISTS thread_message_id BIGINT REFERENCES thread_messages(message_id);
ALTER TABLE crisis_events ADD COLUMN IF NOT EXISTS client_user_id INTEGER REFERENCES users(userid);

ALTER TABLE crisis_events DROP CONSTRAINT IF EXISTS crisis_events_origin_consistency_check;
ALTER TABLE crisis_events ADD CONSTRAINT crisis_events_origin_consistency_check CHECK (
  (origin = 'session' AND session_id IS NOT NULL) OR
  (origin = 'thread_message' AND thread_message_id IS NOT NULL AND client_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_crisis_events_client ON crisis_events(client_user_id) WHERE client_user_id IS NOT NULL;

COMMENT ON COLUMN crisis_events.origin IS
  'session = in-session crisis pipeline; thread_message = async-message safety scan (session_id NULL, thread_message_id + client_user_id set)';

COMMIT;
