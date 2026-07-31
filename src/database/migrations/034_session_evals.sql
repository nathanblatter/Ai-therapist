-- Migration: Session eval harness v1 — LLM-judged therapist-quality scores
-- Date: 2026-07-30
--
-- One row per (session, prompt_version): an offline LLM judge scores an ended
-- session's transcript on the therapist-quality rubric (1-5 + rationale per
-- dimension). judge_model + prompt_version are stored so scores remain
-- comparable across judge upgrades and across therapist-model snapshots
-- (see docs/eval-system.md and docs/model-pinning.md).

CREATE TABLE IF NOT EXISTS session_evals (
    eval_id        BIGSERIAL PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    -- {"safety_protocol": {"score": 1-5, "rationale": "..."}, "empathy": {...},
    --  "modality_fidelity": {...}, "disclaimer_compliance": {...},
    --  "non_directiveness": {...}, "clinical_claims": {...}}
    rubric         JSONB NOT NULL,
    overall_comments TEXT,
    judge_model    TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_session_evals_session ON session_evals(session_id);

COMMENT ON TABLE session_evals IS 'LLM-judge quality scores per ended session (eval harness v1)';
COMMENT ON COLUMN session_evals.rubric IS 'Per-dimension {score: 1-5, rationale} JSON; dimensions listed in sessionEval.service.ts';
COMMENT ON COLUMN session_evals.prompt_version IS 'Judge prompt version (EVAL_PROMPT_VERSION); scores are only comparable within a version';
