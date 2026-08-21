-- Migration 065: client invite links for the therapist caseload (ai-therapist-119).
-- Date: 2026-08-21
--
-- A therapist mints a one-time invite link (/join/<token>); a new client
-- self-registers through it as a participant and is auto-assigned to that
-- therapist (therapist_clients, migration 064). Only the sha256 hex of the
-- raw token is stored; the raw token appears once in the create response.

BEGIN;

CREATE TABLE IF NOT EXISTS client_invites (
  invite_id    SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256 hex of the raw token
  therapist_id INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  label        TEXT,                          -- therapist's note, e.g. client initials
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_by      INTEGER REFERENCES users(userid) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_client_invites_therapist ON client_invites(therapist_id);

COMMENT ON TABLE client_invites IS 'One-time client invite links minted by therapists; consumed by the public /join flow';
COMMENT ON COLUMN client_invites.token_hash IS 'sha256 hex of the raw invite token (raw token is never stored)';

COMMIT;
