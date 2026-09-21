-- Rollback for 104_grok_voice_purpose.sql
--
-- Narrowing the constraint requires removing the rows that violate it first.
-- Those rows are Grok Voice token counts (research record only; the billed
-- cost is in live_usage and is untouched), so this loses token telemetry, not
-- money.

DELETE FROM session_llm_usage WHERE purpose = 'grok_voice';

ALTER TABLE session_llm_usage DROP CONSTRAINT IF EXISTS session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank', 'chat', 'live_delegation'));
