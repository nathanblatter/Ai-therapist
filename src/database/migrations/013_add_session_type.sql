-- Migration: Add session_type column to therapy_sessions
-- Description: Distinguish between realtime (voice) and chat-only therapy sessions
-- Date: 2026-01-05

BEGIN;

-- Add session_type column to therapy_sessions table
ALTER TABLE therapy_sessions
ADD COLUMN session_type VARCHAR(20) DEFAULT 'realtime' CHECK (session_type IN ('realtime', 'chat'));

-- Create index for session_type
CREATE INDEX idx_sessions_session_type ON therapy_sessions(session_type);

-- Add comment
COMMENT ON COLUMN therapy_sessions.session_type IS 'Type of session: realtime (voice+chat via WebRTC) or chat (text-only via GPT-4)';

COMMIT;
