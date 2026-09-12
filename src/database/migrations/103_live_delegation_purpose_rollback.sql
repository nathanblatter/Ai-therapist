-- Rollback for 103_live_delegation_purpose.sql
--
-- Narrowing the constraint requires removing the rows that violate it first,
-- otherwise the ALTER fails. Those rows are GPT-Live backend token usage, so
-- this rollback DOES lose cost data — acceptable only because the alternative
-- is a constraint that cannot be applied at all.

DELETE FROM session_llm_usage WHERE purpose = 'live_delegation';

ALTER TABLE session_llm_usage DROP CONSTRAINT IF EXISTS session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank', 'chat'));
