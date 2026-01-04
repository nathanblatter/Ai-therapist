-- Migration: Add ended_by field to therapy_sessions
-- Description: Track who ended the session (user, admin username, or system)
-- Date: 2026-01-02

ALTER TABLE therapy_sessions
ADD COLUMN ended_by VARCHAR(255);

COMMENT ON COLUMN therapy_sessions.ended_by IS 'Tracks who ended the session: user, admin username, or system';
