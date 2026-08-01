-- Migration 050 (ai-therapist-80): human ratings for the eval rubric.
-- Date: 2026-07-31
--
-- Therapist/researcher raters score ended sessions on the SAME six rubric
-- dimensions the LLM judge uses (EVAL_DIMENSIONS in sessionEval.service.ts),
-- 1-5 each, with optional per-dimension and overall notes. One row per
-- (session, rater); re-submitting overwrites (upsert). rubric_version records
-- which dimension set was in force (currently 'v1') so calibration only
-- compares like with like.

CREATE TABLE IF NOT EXISTS session_human_ratings (
    rating_id      BIGSERIAL PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    rater_user_id  INTEGER NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
    -- {"safety_protocol": {"score": 1-5, "note": "..."}, ... same six keys as
    -- session_evals.rubric; "note" optional (may be absent or empty).
    rubric         JSONB NOT NULL,
    overall_notes  TEXT,
    rubric_version TEXT NOT NULL DEFAULT 'v1',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, rater_user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_human_ratings_session
    ON session_human_ratings(session_id);
CREATE INDEX IF NOT EXISTS idx_session_human_ratings_rater
    ON session_human_ratings(rater_user_id);

COMMENT ON TABLE session_human_ratings IS
    'Human rater scores on the six-dimension eval rubric, one row per (session, rater) (ai-therapist-80)';
COMMENT ON COLUMN session_human_ratings.rubric IS
    'Per-dimension {score: 1-5, note?: string}; keys must match EVAL_DIMENSIONS for the stated rubric_version';
COMMENT ON COLUMN session_human_ratings.rubric_version IS
    'Dimension-set version (matches session_evals.prompt_version major rubric); calibration pairs ratings with LLM evals only within compatible versions';
