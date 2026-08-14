-- Rollback for 056_chat_llm_usage_purpose.sql
-- Removes 'chat' rows first so the narrower constraint can be re-applied.
DELETE FROM session_llm_usage WHERE purpose = 'chat';
ALTER TABLE session_llm_usage DROP CONSTRAINT session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank'));
