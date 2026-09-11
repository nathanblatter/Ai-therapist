-- 101_counterfactual_evals.sql — counterfactual backend-model evaluation
--
-- GPT-Live delegates reasoning to a backend model chosen independently of the
-- voice model, and a session fork may OVERRIDE that backend. That makes a new
-- question answerable on real conversations rather than synthetic ones: given
-- the same session up to the same moment, what would a different model have
-- said?
--
-- This stores those comparisons. One run = one (session, decision point)
-- probed across N candidate models; one response row per candidate.

-- ---------------------------------------------------------------------------
-- 1. Runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counterfactual_runs (
  id                  SERIAL PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  -- How the counterfactual was produced:
  --   'replay' — the conversation up to the decision point is replayed through
  --              the Responses API with the session's backend prompt. Works on
  --              ANY session, bills no voice minutes, and never sends anything
  --              to OpenAI that a normal backend turn would not have sent.
  --   'fork'   — a true GPT-Live session fork with delegation.responses.model
  --              overridden. Higher fidelity (preserves the live session's own
  --              state), but requires the source session to have been stored,
  --              which is restricted to non-study sessions.
  mode                TEXT NOT NULL CHECK (mode IN ('replay', 'fork')),
  -- Index into the session's user/assistant message sequence that the
  -- counterfactual branches from. NULL means the end of the conversation.
  decision_point      INTEGER,
  -- The participant utterance the candidates were asked to respond to.
  probe_text          TEXT,
  -- Why this moment was chosen: 'manual', 'risk_spike', 'session_end'.
  probe_reason        TEXT,
  -- The backend the session ACTUALLY ran on, for reference in the comparison.
  baseline_model      TEXT,
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
  error               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at        TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_counterfactual_runs_session ON counterfactual_runs (session_id);
CREATE INDEX IF NOT EXISTS idx_counterfactual_runs_created ON counterfactual_runs (created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Per-candidate responses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counterfactual_responses (
  id                  SERIAL PRIMARY KEY,
  run_id              INTEGER NOT NULL REFERENCES counterfactual_runs(id) ON DELETE CASCADE,
  model               TEXT NOT NULL,
  -- What the backend produced. For fork mode this is the delegated Responses
  -- output; spoken_text below is what the voice model actually said, which can
  -- differ because GPT-Live paraphrases.
  response_text       TEXT,
  spoken_text         TEXT,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  estimated_cost_usd  NUMERIC(12, 6),
  latency_ms          INTEGER,
  -- Judge scores, populated by an optional second pass. 1-5 like the existing
  -- session rubric so the two are directly comparable.
  judge_scores        JSONB,
  judge_rationale     TEXT,
  -- A candidate that the API rejected (unsupported as a delegation backend,
  -- no project access, rate limited). Recorded rather than dropped so the
  -- unsupported set is discovered empirically — OpenAI publishes no allowlist.
  error               TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, model)
);

CREATE INDEX IF NOT EXISTS idx_counterfactual_responses_run ON counterfactual_responses (run_id);

COMMENT ON TABLE counterfactual_runs IS
  'Counterfactual backend-model comparisons: same session, same moment, different reasoning model.';
COMMENT ON COLUMN counterfactual_responses.error IS
  'Per-candidate failure. A rejected model does not fail the run — OpenAI publishes no delegation-backend allowlist, so the unsupported set is mapped empirically.';
