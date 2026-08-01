-- Migration 055 (ai-therapist-88): RAG rerank decision logging.
-- Date: 2026-07-31
--
-- One row per listwise LLM rerank call over pgvector candidates (including
-- fallback calls that returned vector order), so the movement/latency/fallback
-- rate can be judged before investing in a real rerank eval. The 'rerank'
-- session_llm_usage purpose was added in migration 054.

CREATE TABLE IF NOT EXISTS rag_rerank_decisions (
  decision_id   BIGSERIAL PRIMARY KEY,
  session_id    TEXT REFERENCES therapy_sessions(session_id) ON DELETE SET NULL,
  tool_name     VARCHAR(100) NOT NULL,
  query         TEXT NOT NULL,            -- model-authored tool arg (same exposure class as tool_invocations.arguments)
  candidates    JSONB NOT NULL,           -- [{chunk_id, vec_rank, similarity}]
  chosen        JSONB NOT NULL,           -- [chunk_id, ...] final order
  used_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  model         VARCHAR(100),
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rerank_decisions_tool_time
  ON rag_rerank_decisions(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rerank_decisions_session
  ON rag_rerank_decisions(session_id);

COMMENT ON TABLE rag_rerank_decisions IS 'One row per listwise LLM rerank call over RAG vector candidates, for movement/fallback/latency eval (ai-therapist-88)';
