-- 103_live_delegation_purpose.sql — allow purpose 'live_delegation'
--
-- Migration 098 claimed no constraint change was needed:
--   "The purpose column is a free-text TEXT column, so no enum change is
--    needed; this is documentation of the new value only."
-- That was WRONG. session_llm_usage.purpose is VARCHAR(30) NOT NULL with a
-- CHECK constraint (046), last re-created by 056 as:
--   CHECK (purpose IN ('insights','redaction','crisis','eligibility','rerank','chat'))
--
-- The GPT-Live sideband writes 'live_delegation' on every delegated Responses
-- completion, and recordLlmUsage deliberately swallows its own errors so a
-- metering failure can never affect a live voice session. The result was silent:
-- every insert failed with SQLSTATE 23514 and produced nothing but a log line,
-- so ALL GPT-Live backend token usage was discarded and the cost dashboard
-- under-reported voice spend by the entire delegated-reasoning half of it.

ALTER TABLE session_llm_usage DROP CONSTRAINT IF EXISTS session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank', 'chat', 'live_delegation'));

COMMENT ON COLUMN session_llm_usage.purpose IS
  'insights | redaction | crisis | eligibility | rerank | chat | live_delegation (enforced by session_llm_usage_purpose_check)';
