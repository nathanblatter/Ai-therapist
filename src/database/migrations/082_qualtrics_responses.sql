-- Migration 082: synced Qualtrics survey responses (ai-therapist-149).
-- Date: 2026-09-02
--
-- The analysis-side half of the Qualtrics integration: a local, linkable copy
-- of every study-survey response (baseline / weekly / exit / week-12), synced
-- from the Qualtrics response-export API by qualtricsSync.service.ts.
--
-- Linkage model:
--   * user_id is resolved at sync time from, in order: (1) the `sid` embedded
--     data stamped by the app's personalized survey links, (2) the typed
--     study-ID answer (WID/XID/FID), (3) qualtrics_signups for baseline
--     responses (ResponseID -> account created via /join-study).
--   * Dataset exports join through research_pseudonyms exactly like every
--     other artifact, so survey rows leave the system keyed by P00x only.

BEGIN;

CREATE TABLE IF NOT EXISTS qualtrics_responses (
  qr_id        SERIAL PRIMARY KEY,
  response_id  TEXT NOT NULL UNIQUE,        -- Qualtrics ResponseID (R_...)
  survey_id    TEXT NOT NULL,               -- SV_...
  survey_role  TEXT NOT NULL CHECK (survey_role IN ('baseline','weekly','exit','week12')),
  user_id      INTEGER REFERENCES users(userid) ON DELETE SET NULL,
  study_sid    TEXT,                        -- sid embedded data / typed study-ID, as received
  finished     BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at  TIMESTAMPTZ,                 -- Qualtrics recordedDate
  answers      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the response's `values` payload
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qualtrics_responses_user ON qualtrics_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_qualtrics_responses_role ON qualtrics_responses(survey_role);

COMMIT;
