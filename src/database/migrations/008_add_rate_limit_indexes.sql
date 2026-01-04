-- Migration: Add indexes to optimize rate limit queries
-- Created: 2026-01-03
-- Description: Adds performance indexes for rate limit calculations

-- Optimize rate limit queries by indexing user_id and created_at
-- This index speeds up the daily session count queries used in rate limiting
CREATE INDEX IF NOT EXISTS idx_sessions_user_created
ON therapy_sessions(user_id, created_at DESC)
WHERE user_id IS NOT NULL;

COMMENT ON INDEX idx_sessions_user_created IS 'Optimize rate limit queries for sessions by user and date';
