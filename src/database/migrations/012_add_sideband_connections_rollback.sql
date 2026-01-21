-- Rollback: Remove sideband WebSocket connection tracking
-- Created: 2026-01-04
-- Description: Rollback migration 012 - remove sideband connection columns

BEGIN;

-- Drop indexes
DROP INDEX IF EXISTS idx_sessions_sideband_connected;
DROP INDEX IF EXISTS idx_sessions_call_id;

-- Remove columns from therapy_sessions
ALTER TABLE therapy_sessions
DROP COLUMN IF EXISTS sideband_error,
DROP COLUMN IF EXISTS sideband_disconnected_at,
DROP COLUMN IF EXISTS sideband_connected_at,
DROP COLUMN IF EXISTS sideband_connected,
DROP COLUMN IF EXISTS openai_call_id;

COMMIT;
