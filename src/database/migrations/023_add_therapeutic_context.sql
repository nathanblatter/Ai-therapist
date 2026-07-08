-- Therapeutic context features (flightdeck ai-therapist-39..44):
-- cross-session memory + SOAP notes (session_insights), pre-session check-in,
-- per-session therapeutic modality, and the participant's memory consent flag.

-- One row per ended session: a structured memory summary (used to build
-- returning-participant context for future sessions) and an AI-drafted
-- SOAP-style clinical note awaiting therapist review.
CREATE TABLE IF NOT EXISTS session_insights (
  session_id TEXT PRIMARY KEY REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(userid) ON DELETE CASCADE,
  summary JSONB,
  soap_note JSONB,
  soap_status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (soap_status IN ('draft', 'reviewed')),
  soap_reviewed_by VARCHAR(255),
  soap_reviewed_at TIMESTAMPTZ,
  model VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_insights_user
  ON session_insights(user_id, created_at DESC);

-- Pre-session check-in: { mood: 1-10, topic, goal, submitted_at }
ALTER TABLE therapy_sessions ADD COLUMN IF NOT EXISTS checkin JSONB;

-- Which therapeutic modality preset (cbt/act/mi/supportive) was active when
-- the session's instructions were assembled — the research condition.
ALTER TABLE session_configurations ADD COLUMN IF NOT EXISTS modality VARCHAR(50);

-- Participant consent for cross-session memory (opt-in).
ALTER TABLE users ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT FALSE;
