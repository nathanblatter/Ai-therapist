-- Migration 035 (ai-therapist-25c): per-session cost/token tracking.
-- Logs one row per non-realtime LLM call made ON BEHALF OF a session
-- (insights generation, redaction, crisis risk assessment) so the admin
-- dashboard can show per-session and daily estimated spend. Realtime voice
-- minutes are NOT token-metered by this table — they're derived from
-- therapy_sessions.created_at/ended_at directly in the query layer.

CREATE TABLE IF NOT EXISTS session_llm_usage (
  usage_id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  purpose VARCHAR(30) NOT NULL CHECK (purpose IN ('insights', 'redaction', 'crisis')),
  model VARCHAR(100),
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_llm_usage_session
  ON session_llm_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_session_llm_usage_purpose_time
  ON session_llm_usage(purpose, created_at DESC);

COMMENT ON TABLE session_llm_usage IS 'One row per insights/redaction/crisis LLM call, for per-session and daily cost tracking (ai-therapist-25c)';
COMMENT ON COLUMN session_llm_usage.tokens_in IS 'Prompt/input tokens if the API response exposed usage; NULL when not available (e.g. Responses API calls that were not instrumented)';
