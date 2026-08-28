-- Migration 073: work_items — the caseworker/therapist work queue
-- (caseworker portal, docs/caseworker-portal.md section 1). Materialized table,
-- not a view: the ack/resolve lifecycle and pool-assignment routing are state
-- no source table owns; the inactivity type has no source row at all.
-- Idempotent producers via UNIQUE (item_type, source_table, source_id) +
-- ON CONFLICT DO NOTHING.
-- Date: 2026-08-27

BEGIN;

CREATE TABLE IF NOT EXISTS work_items (
  item_id      BIGSERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id    INTEGER REFERENCES users(userid) ON DELETE CASCADE,
  assignee_id  INTEGER REFERENCES users(userid) ON DELETE SET NULL, -- NULL = pool item for the client's care team
  assignee_role TEXT CHECK (assignee_role IN ('caseworker','therapist')),
  item_type    TEXT NOT NULL CHECK (item_type IN (
    'crisis_flag','message_crisis','adverse_event','escalation_inbound','escalation_response',
    'note_awaiting_signature','inactivity','screener_worsening','message_unread_stale')),
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','urgent')),
  title        TEXT NOT NULL,
  detail       JSONB,                       -- reason payload; NEVER transcript/message text
  source_table TEXT NOT NULL,
  source_id    TEXT NOT NULL,               -- covers bigserial ids and synthetic keys like 'inactivity:42:2026-08-27'
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','resolved','expired')),
  acked_by     INTEGER REFERENCES users(userid), acked_at TIMESTAMPTZ,
  resolved_by  INTEGER REFERENCES users(userid), resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  is_sandbox   BOOLEAN NOT NULL DEFAULT false,   -- stamped from users.is_sandbox at insert
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_type, source_table, source_id)    -- idempotent producers
);
CREATE INDEX IF NOT EXISTS idx_work_items_assignee_open ON work_items(assignee_id, status) WHERE status IN ('open','acked');
CREATE INDEX IF NOT EXISTS idx_work_items_client ON work_items(client_id, created_at DESC);

COMMIT;
