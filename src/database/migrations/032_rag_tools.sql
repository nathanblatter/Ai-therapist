-- Migration: Extend the knowledge base for worksheet + modality-technique RAG,
-- and embed user memories for semantic recall.
-- Date: 2026-07-22
-- Depends on 031 (knowledge_chunks + pgvector extension already present).

-- knowledge_chunks now holds multiple kinds of content:
--   'psychoeducation' (default, existing rows), 'worksheet', 'technique'.
-- modality tags techniques to an approach (cbt/act/mi/supportive); metadata
-- carries structured hints (e.g. which render tool a worksheet maps to).
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS kind     TEXT NOT NULL DEFAULT 'psychoeducation',
  ADD COLUMN IF NOT EXISTS modality TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_chunks(kind);

-- Embed participant-approved memories so recall_relevant_history can do semantic
-- retrieval within a single user's own facts (exact KNN filtered by user_id;
-- no ANN index needed at per-user scale).
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

COMMENT ON COLUMN knowledge_chunks.kind IS 'psychoeducation | worksheet | technique';
COMMENT ON COLUMN knowledge_chunks.modality IS 'For techniques: cbt | act | mi | supportive | NULL (general)';
COMMENT ON COLUMN user_memories.embedding IS 'text-embedding-3-small of the fact; NULL until embedded';
