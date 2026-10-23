-- 111: FK-cascade and work-queue indexes from docs/db-index-audit.md (2026-10-23).
--
-- Plain (non-CONCURRENT) index builds: every table here is small (hundreds of
-- rows on prod), so the brief lock is harmless and the file runs under the
-- transactional runners (runMigrationRange.js, redteam-db-setup.sh). Stage:
--   docker exec -i docker-services-postgres-1 psql -U postgres -d ai_therapist < this file
-- Prod: psql against RDS with PGSSLMODE=require after the usual backup.
--
-- 1. The only unindexed FK that backs a user-facing list query
--    (workQueue.queries.ts listOrgWorkItems: WHERE org_id = $1 AND status = ANY($2)).
CREATE INDEX IF NOT EXISTS idx_work_items_org_status
  ON work_items (org_id, status);

-- 2. Message-delete cascades (session delete, retention, participant wipe)
--    walk these child tables per deleted message.
CREATE INDEX IF NOT EXISTS idx_risk_score_history_message
  ON risk_score_history (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crisis_events_message
  ON crisis_events (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crisis_events_thread_message
  ON crisis_events (thread_message_id) WHERE thread_message_id IS NOT NULL;

-- 3. Session-delete cascades.
CREATE INDEX IF NOT EXISTS idx_user_memories_session
  ON user_memories (session_id);
CREATE INDEX IF NOT EXISTS idx_escalations_session
  ON escalations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protocol_deviations_session
  ON protocol_deviations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_eval_pairs_session_b
  ON session_eval_pairs (session_b);
