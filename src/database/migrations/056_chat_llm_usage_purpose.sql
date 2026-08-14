-- Migration 056 (ai-therapist-118): chat-pipeline cost tracking.
-- Date: 2026-08-13
--
-- The chat pipeline's main Responses API calls (chatTherapy.service.ts) now
-- log token usage per call, like insights/redaction/crisis already do. Allow
-- the new 'chat' purpose in session_llm_usage (constraint last widened in
-- migration 054).

ALTER TABLE session_llm_usage DROP CONSTRAINT session_llm_usage_purpose_check;
ALTER TABLE session_llm_usage ADD CONSTRAINT session_llm_usage_purpose_check
  CHECK (purpose IN ('insights', 'redaction', 'crisis', 'eligibility', 'rerank', 'chat'));
