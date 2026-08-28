-- Migration 072: escalations + escalation_events (caseworker portal,
-- docs/caseworker-portal.md section 1). State machine: open -> acknowledged ->
-- resolved (open -> resolved direct allowed; resolved -> open reopen clears
-- ack/resolve fields). assigned_to NULL = org unassigned queue; any org
-- therapist may claim (atomic WHERE assigned_to IS NULL).
-- Date: 2026-08-27

BEGIN;

CREATE TABLE IF NOT EXISTS escalations (
  escalation_id   BIGSERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id       INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  raised_by       INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  raised_by_role  TEXT NOT NULL CHECK (raised_by_role IN ('caseworker','therapist')),
  assigned_to     INTEGER REFERENCES users(userid) ON DELETE SET NULL, -- NULL = org unassigned queue
  reason          TEXT NOT NULL,
  urgency         TEXT NOT NULL CHECK (urgency IN ('routine','urgent','emergency')),
  crisis_event_id BIGINT REFERENCES crisis_events(event_id) ON DELETE SET NULL,
  session_id      TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  note_id         BIGINT REFERENCES care_notes(note_id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  acknowledged_at TIMESTAMPTZ,
  resolved_by     INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalations_assignee_open ON escalations (assigned_to, created_at DESC) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_escalations_org_unassigned ON escalations (org_id, created_at DESC) WHERE assigned_to IS NULL AND status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_escalations_client ON escalations (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS escalation_events (
  event_id       BIGSERIAL PRIMARY KEY,
  escalation_id  BIGINT NOT NULL REFERENCES escalations(escalation_id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL CHECK (event_type IN
    ('created','acknowledged','resolved','reopened','reassigned','claimed','comment')),
  actor_user_id  INTEGER,
  actor_username TEXT,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalation_events_escalation ON escalation_events (escalation_id, created_at);

COMMENT ON TABLE escalations IS
  'Caseworker <-> therapist escalations. All transitions are guarded UPDATE ... WHERE status = expected (409 on lost race).';

COMMIT;
