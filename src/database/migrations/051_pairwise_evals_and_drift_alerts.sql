-- Migration 051 (ai-therapist-81, ai-therapist-84): pairwise A/B eval results
-- and eval-drift alerts.
-- Date: 2026-07-31
--
-- session_eval_pairs: one row per judged pair of matched ended sessions
-- (same modality + duration band, different arms of a comparison axis).
-- Position-debiased: the judge runs on both orderings (A-first and B-first);
-- verdict_ab / verdict_ba store each ordering's winner ('a'/'b' always in
-- CANONICAL pair terms, i.e. relative to session_a/session_b, not to
-- presentation order). final_verdict merges them ('inconsistent' when the two
-- orderings name different winners — counted as a tie in win-rates).
--
-- eval_drift_alerts: open/acknowledged regression alerts raised when a rubric
-- dimension's rolling mean drops beyond the configured threshold.

CREATE TABLE IF NOT EXISTS session_eval_pairs (
    pair_id         BIGSERIAL PRIMARY KEY,
    session_a       TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    session_b       TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
    comparison_axis TEXT NOT NULL CHECK (comparison_axis IN ('ai_model', 'proactive_offering')),
    arm_a           TEXT NOT NULL,   -- session_a's arm value (model string / 'proactive' / 'reactive')
    arm_b           TEXT NOT NULL,   -- session_b's arm value; arm_a <> arm_b
    modality        TEXT,            -- shared modality key (NULL = none configured, matched on NULL too)
    duration_band   TEXT NOT NULL CHECK (duration_band IN ('short', 'medium', 'long')),
    judge_model     TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,   -- PAIRWISE_PROMPT_VERSION at judge time
    verdict_ab      TEXT NOT NULL CHECK (verdict_ab IN ('a', 'b', 'tie')),  -- A presented first
    verdict_ba      TEXT NOT NULL CHECK (verdict_ba IN ('a', 'b', 'tie')),  -- B presented first
    rationale_ab    TEXT,
    rationale_ba    TEXT,
    final_verdict   TEXT NOT NULL CHECK (final_verdict IN ('a', 'b', 'tie', 'inconsistent')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (session_a < session_b),   -- canonical ordering: no duplicate mirrored pairs
    CHECK (arm_a <> arm_b),
    UNIQUE (session_a, session_b, comparison_axis, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_eval_pairs_axis
    ON session_eval_pairs(comparison_axis, prompt_version);

CREATE TABLE IF NOT EXISTS eval_drift_alerts (
    alert_id        BIGSERIAL PRIMARY KEY,
    dimension       TEXT NOT NULL,
    ai_model        TEXT,            -- NULL = unknown-model bucket
    prompt_version  TEXT NOT NULL,
    rolling_mean    NUMERIC(4,2) NOT NULL,
    baseline_mean   NUMERIC(4,2) NOT NULL,
    drop_amount     NUMERIC(4,2) NOT NULL,  -- baseline_mean - rolling_mean
    window_n        INTEGER NOT NULL,       -- evals in the rolling window
    baseline_n      INTEGER NOT NULL,
    paged           BOOLEAN NOT NULL DEFAULT FALSE,  -- iMessage page attempted
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by INTEGER REFERENCES users(userid) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- At most ONE open (unacknowledged) alert per (dimension, model, prompt version):
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_drift_alerts_open
    ON eval_drift_alerts(dimension, COALESCE(ai_model, ''), prompt_version)
    WHERE acknowledged_at IS NULL;

COMMENT ON TABLE session_eval_pairs IS 'Position-debiased pairwise LLM-judge comparisons of matched sessions (ai-therapist-81)';
COMMENT ON COLUMN session_eval_pairs.final_verdict IS 'a/b = that session won BOTH orderings (or won one and tied the other); tie = tied both; inconsistent = orderings disagreed (position bias) — treated as tie in win-rates';
COMMENT ON TABLE eval_drift_alerts IS 'Rubric-score regression alerts from evalDrift.service.ts (ai-therapist-84)';
