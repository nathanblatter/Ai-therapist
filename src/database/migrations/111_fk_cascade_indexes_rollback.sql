-- Rollback for 111: drop the cascade/work-queue indexes. Transactional, like the forward file.
DROP INDEX IF EXISTS idx_work_items_org_status;
DROP INDEX IF EXISTS idx_risk_score_history_message;
DROP INDEX IF EXISTS idx_crisis_events_message;
DROP INDEX IF EXISTS idx_crisis_events_thread_message;
DROP INDEX IF EXISTS idx_user_memories_session;
DROP INDEX IF EXISTS idx_escalations_session;
DROP INDEX IF EXISTS idx_protocol_deviations_session;
DROP INDEX IF EXISTS idx_session_eval_pairs_session_b;
