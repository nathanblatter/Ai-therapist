-- Migration 074: notifications + per-user notification preferences
-- (caseworker portal, docs/caseworker-portal.md sections 1 and 5).
-- Date: 2026-08-27

BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  work_item_id BIGINT REFERENCES work_items(item_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,          -- work-item types + 'digest' + 'note_shared' (spec section 5 catalog)
  title        TEXT NOT NULL,
  body         TEXT,
  read_at      TIMESTAMPTZ,
  emailed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    INTEGER PRIMARY KEY REFERENCES users(userid) ON DELETE CASCADE,
  email_mode TEXT NOT NULL DEFAULT 'digest' CHECK (email_mode IN ('immediate','digest','off')),
  urgent_email_immediate BOOLEAN NOT NULL DEFAULT true,
  digest_hour_local INTEGER NOT NULL DEFAULT 8 CHECK (digest_hour_local BETWEEN 0 AND 23),
  in_app_enabled BOOLEAN NOT NULL DEFAULT true
);

COMMIT;
