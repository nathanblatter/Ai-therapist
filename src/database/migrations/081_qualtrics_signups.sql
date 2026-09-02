-- Migration 081: Qualtrics baseline-survey signup links (ai-therapist-149).
-- Date: 2026-09-02
--
-- Phase 2 enrollment glue: when a participant finishes the baseline Qualtrics
-- survey, the end-of-survey redirect sends them to /join-study?qid=<ResponseID>.
-- The server verifies the response with the Qualtrics API (finished, right
-- survey) and lets them create their participant account in one step.
--
-- One row per claimed Qualtrics response. The UNIQUE(response_id) constraint is
-- the single-use gate (claim = INSERT ... ON CONFLICT DO NOTHING), and the
-- stored response_id doubles as the dataset-linkage key between in-app data and
-- the Qualtrics export (join on qualtrics_signups.response_id).

BEGIN;

CREATE TABLE IF NOT EXISTS qualtrics_signups (
  signup_id    SERIAL PRIMARY KEY,
  response_id  TEXT NOT NULL UNIQUE,   -- Qualtrics ResponseID (R_...)
  survey_id    TEXT NOT NULL,          -- Qualtrics survey the response belongs to (SV_...)
  user_id      INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at TIMESTAMPTZ            -- set once the account is actually created
);

CREATE INDEX IF NOT EXISTS idx_qualtrics_signups_user ON qualtrics_signups(user_id);

COMMIT;
