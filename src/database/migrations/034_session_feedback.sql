-- Migration 034 (ai-therapist-25b): post-session participant feedback survey.
-- Shown once, after session end, in the main app. Two short Likert questions
-- (1-5) + optional free text, stored per session and shown in admin Session
-- Detail. Participant-optional: rows only exist when they actually submit.

CREATE TABLE IF NOT EXISTS session_feedback (
  feedback_id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  helpfulness_rating SMALLINT CHECK (helpfulness_rating BETWEEN 1 AND 5),
  ease_rating SMALLINT CHECK (ease_rating BETWEEN 1 AND 5),
  would_return_rating SMALLINT CHECK (would_return_rating BETWEEN 1 AND 5),
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- one feedback submission per session
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_feedback_session
  ON session_feedback(session_id);

COMMENT ON TABLE session_feedback IS 'Post-session participant Likert + free-text feedback (ai-therapist-25b)';
COMMENT ON COLUMN session_feedback.comments IS 'Free text; goes through the same redaction/storage rules as messages — treat as participant-authored content';
