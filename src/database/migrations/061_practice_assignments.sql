-- Migration 061: between-session practice assignments (ai-therapist-123).
-- Date: 2026-08-14
--
-- The AI could look BACK at past worksheets (review_practice) but had no way
-- to assign forward-looking practice, and nothing followed up. This table
-- backs the assign_practice tool, the participant "Your practice" card on the
-- progress home (/api/me/assignments), the returning-participant prompt
-- follow-up line, and the clinician prep digest.

BEGIN;

CREATE TABLE IF NOT EXISTS practice_assignments (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(userid),
  session_id TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('worksheet', 'exercise', 'observation', 'custom')) DEFAULT 'custom',
  suggested_frequency TEXT,
  status TEXT CHECK (status IN ('assigned', 'completed', 'skipped')) DEFAULT 'assigned',
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  completion_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_practice_assignments_user_status
  ON practice_assignments (user_id, status);

CREATE INDEX IF NOT EXISTS idx_practice_assignments_session
  ON practice_assignments (session_id);

COMMENT ON TABLE practice_assignments IS 'Between-session practice the AI assigned with the participant''s agreement (assign_practice tool)';
COMMENT ON COLUMN practice_assignments.kind IS 'worksheet | exercise | observation | custom';
COMMENT ON COLUMN practice_assignments.status IS 'assigned | completed | skipped';
COMMENT ON COLUMN practice_assignments.completion_note IS 'Optional short participant note captured when marking the practice done';

COMMIT;
