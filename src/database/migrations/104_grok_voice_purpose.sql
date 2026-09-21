-- 104_grok_voice_purpose.sql — allow purpose 'grok_voice'
--
-- The Grok Voice proxy (docs/grok-voice.md) records per-response token counts
-- from xAI's response.done into session_llm_usage with purpose 'grok_voice',
-- for the research record (the money is billed per audio minute and lives in
-- live_usage; estimateCostUsd prices these rows at zero).
--
-- Same failure class as 103: the purpose CHECK constraint rejected the new
-- value, recordLlmUsage swallowed the error by design, and the first stage
-- session (2026-09-21) logged three SQLSTATE 23514 lines and kept no token
-- rows. Extending the constraint is the whole fix.

ALTER TABLE session_llm_usage DROP CONSTRAINT IF EXISTS session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank', 'chat', 'live_delegation', 'grok_voice'));

COMMENT ON COLUMN session_llm_usage.purpose IS
  'insights | redaction | crisis | eligibility | rerank | chat | live_delegation | grok_voice (enforced by session_llm_usage_purpose_check)';
