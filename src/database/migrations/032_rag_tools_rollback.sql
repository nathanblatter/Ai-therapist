-- Rollback for 032_rag_tools.sql

DROP INDEX IF EXISTS idx_knowledge_kind;

ALTER TABLE knowledge_chunks
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS modality,
  DROP COLUMN IF EXISTS metadata;

ALTER TABLE user_memories
  DROP COLUMN IF EXISTS embedding;
