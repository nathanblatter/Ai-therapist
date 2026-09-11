-- Rollback for 098_gpt_live.sql
--
-- Safe at any time: the Realtime path never reads these objects. Any session
-- currently running on GPT-Live loses only its voice-duration metering; the
-- conversation, transcripts and safety records live in the shared tables.

DROP INDEX IF EXISTS idx_live_usage_created_at;
DROP TABLE IF EXISTS live_usage;

DROP INDEX IF EXISTS idx_therapy_sessions_live_reattach;
ALTER TABLE therapy_sessions DROP COLUMN IF EXISTS openai_live_session_id;

COMMENT ON COLUMN session_llm_usage.purpose IS NULL;
