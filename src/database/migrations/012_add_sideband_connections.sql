-- Migration: Add sideband WebSocket connection tracking
-- Created: 2026-01-04
-- Description: Add columns to therapy_sessions for tracking OpenAI Realtime API sideband connections

BEGIN;

-- Add sideband connection tracking columns to therapy_sessions
ALTER TABLE therapy_sessions
ADD COLUMN openai_call_id TEXT UNIQUE,
ADD COLUMN sideband_connected BOOLEAN DEFAULT FALSE,
ADD COLUMN sideband_connected_at TIMESTAMPTZ,
ADD COLUMN sideband_disconnected_at TIMESTAMPTZ,
ADD COLUMN sideband_error TEXT;

-- Create indexes for efficient queries
CREATE INDEX idx_sessions_call_id ON therapy_sessions(openai_call_id)
  WHERE openai_call_id IS NOT NULL;

CREATE INDEX idx_sessions_sideband_connected ON therapy_sessions(sideband_connected)
  WHERE sideband_connected = TRUE;

-- Add comments for documentation
COMMENT ON COLUMN therapy_sessions.openai_call_id IS 'OpenAI Realtime API call_id extracted from Location header';
COMMENT ON COLUMN therapy_sessions.sideband_connected IS 'Whether server-side sideband WebSocket is currently connected';
COMMENT ON COLUMN therapy_sessions.sideband_connected_at IS 'Timestamp when sideband connection was established';
COMMENT ON COLUMN therapy_sessions.sideband_disconnected_at IS 'Timestamp when sideband connection was closed';
COMMENT ON COLUMN therapy_sessions.sideband_error IS 'Last error message from sideband connection';

COMMIT;
