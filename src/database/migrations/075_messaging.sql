-- Migration 075: async messaging — one thread per (client, clinician) pair,
-- not a shared care-team thread, so the caseworker tier is structurally
-- enforced (a caseworker never has read access to the client<->therapist
-- thread; nothing to redact). Threads are bound to an active care-team
-- assignment; unassign freezes (read-only, retained), re-assign of the same
-- pair unfreezes the same thread. (caseworker portal, spec section 1)
-- Date: 2026-08-27

BEGIN;

CREATE TABLE IF NOT EXISTS message_threads (
  thread_id     BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(org_id),
  client_id     INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  clinician_id  INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  clinician_role TEXT NOT NULL CHECK (clinician_role IN ('therapist','caseworker')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  frozen_at     TIMESTAMPTZ,
  frozen_reason TEXT,                            -- 'unassigned' | 'client_deactivated' | 'manual'
  is_sandbox    BOOLEAN NOT NULL DEFAULT FALSE,  -- stamped from users.is_sandbox at creation
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (client_id, clinician_id)
);
CREATE INDEX IF NOT EXISTS idx_message_threads_clinician ON message_threads(clinician_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_threads_client ON message_threads(client_id);

CREATE TABLE IF NOT EXISTS thread_messages (
  message_id    BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES message_threads(thread_id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(userid),
  sender_role   TEXT NOT NULL CHECK (sender_role IN ('participant','therapist','caseworker')),
  body          TEXT NOT NULL CHECK (char_length(body) <= 4000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  risk_score    INTEGER,                         -- scan results: participant messages only
  risk_severity TEXT CHECK (risk_severity IN ('low','medium','high')),
  scan_status   TEXT NOT NULL DEFAULT 'not_applicable'
                CHECK (scan_status IN ('not_applicable','pending','clear','flagged','scan_failed')),
  crisis_event_id BIGINT REFERENCES crisis_events(event_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, message_id DESC);
CREATE INDEX IF NOT EXISTS idx_thread_messages_flagged ON thread_messages(thread_id) WHERE scan_status = 'flagged';

CREATE TABLE IF NOT EXISTS thread_read_state (
  thread_id  BIGINT NOT NULL REFERENCES message_threads(thread_id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

COMMENT ON TABLE thread_messages IS
  'Async messages. No edit/delete of sent messages in v1 (clinical record integrity).';

COMMIT;
