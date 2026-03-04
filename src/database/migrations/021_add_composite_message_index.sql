-- 021: Add composite index on messages(session_id, created_at DESC)
-- Covers the common WHERE session_id = $1 ORDER BY created_at DESC pattern

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at DESC);
