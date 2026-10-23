-- Migration 107: judge ensemble + self-consistency for the session eval
-- harness (eval spec gap G6).
-- Date: 2026-10-22
--
-- session_evals keeps ONE consensus row per (session, prompt_version) so every
-- consumer (drift, calibration, export, admin panels) keeps working. The raw
-- per-judge, per-run scores that the consensus is the median of land here, one
-- row per (session, prompt_version, judge_model, run_index). Rows are replaced
-- wholesale on every (re-)evaluation of a session.
--
-- session_evals.judge_spread records the consensus row's per-dimension
-- disagreement (max - min score across all judge runs); NULL for legacy
-- single-judge rows.

BEGIN;

CREATE TABLE IF NOT EXISTS session_eval_judges (
    eval_judge_id    BIGSERIAL PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    prompt_version   TEXT NOT NULL,
    judge_model      TEXT NOT NULL,
    -- 0-based self-consistency run index (0 = the only run when
    -- evals.self_consistency_runs is 1).
    run_index        INTEGER NOT NULL DEFAULT 0,
    -- Seed passed to the model for runs > 1 (best-effort determinism); NULL
    -- when no seed was sent.
    seed             INTEGER,
    -- Same shape as session_evals.rubric: {dimension: {score 1-5, rationale}}.
    rubric           JSONB NOT NULL,
    overall_comments TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, prompt_version, judge_model, run_index)
);

CREATE INDEX IF NOT EXISTS idx_session_eval_judges_version
    ON session_eval_judges(prompt_version, judge_model);

ALTER TABLE session_evals ADD COLUMN IF NOT EXISTS judge_spread JSONB;

COMMENT ON TABLE session_eval_judges IS 'Raw per-judge / per-run rubric scores behind each session_evals consensus row (judge ensemble, migration 107)';
COMMENT ON COLUMN session_evals.judge_spread IS 'Per-dimension max-min score across the judge runs that produced this consensus row; NULL for single-judge rows';

COMMIT;
