-- 098_gpt_live.sql — GPT-Live voice backend (gpt-live-1)
--
-- GPT-Live is OpenAI's full-duplex voice model. It replaces the Realtime API's
-- token metering with flat per-second billing, and it identifies a session by an
-- opaque `live_...` session id returned in the JSON body of POST /v1/live/sessions
-- (rather than the Realtime `call_id` scraped from a Location header).
--
-- This migration is ADDITIVE. The Realtime path is untouched and stays the
-- default: a session only runs on GPT-Live when system_config.ai_model names a
-- gpt-live model. Rollback simply drops the new column/table.

-- ---------------------------------------------------------------------------
-- 1. Session linkage
-- ---------------------------------------------------------------------------
-- Kept separate from openai_call_id on purpose. A Realtime call_id and a Live
-- session id are different namespaces with different attach URLs, and the
-- sideband reattach query needs to tell them apart after a restart.
ALTER TABLE therapy_sessions
  ADD COLUMN IF NOT EXISTS openai_live_session_id TEXT;

COMMENT ON COLUMN therapy_sessions.openai_live_session_id IS
  'Opaque GPT-Live session id (live_...) from POST /v1/live/sessions. NULL for Realtime sessions.';

CREATE INDEX IF NOT EXISTS idx_therapy_sessions_live_reattach
  ON therapy_sessions (created_at)
  WHERE status = 'active' AND openai_live_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Voice-duration metering
-- ---------------------------------------------------------------------------
-- GPT-Live bills the VOICE session per second (not rounded up to the minute),
-- and bills delegated backend Responses work separately at normal model rates.
-- session.usage.updated reports a CUMULATIVE snapshot, never an increment, so
-- this table holds one row per session that is overwritten as snapshots arrive.
-- Storing the latest snapshot (rather than appending) is what makes the numbers
-- safe to SUM across sessions without double counting.
CREATE TABLE IF NOT EXISTS live_usage (
  session_id          TEXT PRIMARY KEY
                        REFERENCES therapy_sessions(session_id) ON DELETE CASCADE,
  model               TEXT        NOT NULL,
  -- Latest cumulative voice duration reported by the API, in seconds.
  duration_seconds    NUMERIC(12, 3) NOT NULL DEFAULT 0,
  -- TRUE once session.closed has been observed. Until then the duration is the
  -- last in-flight snapshot and final usage is formally unconfirmed — the docs
  -- are explicit that a socket close alone does not establish finalization.
  finalized           BOOLEAN     NOT NULL DEFAULT FALSE,
  -- session.closed `reason`: close_requested | expired | content |
  -- remote_hangup | connection_lost. NULL while the session is running.
  close_reason        TEXT,
  -- Peak context_window.usage_ratio seen. GPT-Live swaps in a replacement voice
  -- engine past 90%, which drops older history — worth knowing when a transcript
  -- looks like it lost the thread.
  peak_context_ratio  NUMERIC(5, 4),
  created_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_live_usage_created_at ON live_usage (created_at);

COMMENT ON TABLE live_usage IS
  'Per-second voice billing for GPT-Live sessions. One row per session, holding the LATEST cumulative snapshot from session.usage.updated / session.closed. Delegated backend token usage lands in session_llm_usage with purpose=''live_delegation''.';

-- ---------------------------------------------------------------------------
-- 3. Delegated-backend token usage
-- ---------------------------------------------------------------------------
-- Responses delegation bills the backend model separately. Those usage figures
-- arrive as nested response.completed events and belong in the existing
-- per-session LLM usage table, so the cost dashboard picks them up for free.
-- The purpose column is a free-text TEXT column, so no enum change is needed;
-- this is documentation of the new value only.
COMMENT ON COLUMN session_llm_usage.purpose IS
  'insights | redaction | crisis | eligibility | rerank | chat | live_delegation';
