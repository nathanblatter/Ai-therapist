-- Tool-calling suite (flightdeck ai-therapist-26..32):
-- per-invocation analytics log and the session goal set by the model.

-- One row per tool call the model makes, with the session's risk score at
-- invocation time — lets the study correlate tool usage with risk trajectory.
CREATE TABLE IF NOT EXISTS tool_invocations (
  invocation_id SERIAL PRIMARY KEY,
  session_id TEXT REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  tool_name VARCHAR(100) NOT NULL,
  arguments JSONB,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  risk_score_at INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_session
  ON tool_invocations(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_name_time
  ON tool_invocations(tool_name, created_at DESC);

-- Session goal set via the set_session_goal tool (distinct from the
-- participant's pre-session check-in goal, which lives in checkin->>'goal').
ALTER TABLE therapy_sessions ADD COLUMN IF NOT EXISTS session_goal TEXT;
