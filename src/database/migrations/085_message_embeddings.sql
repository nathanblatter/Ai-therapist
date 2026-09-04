-- 085: Message embeddings for semantic-trajectory research analyses.
--
-- Adds a pgvector column on messages, populated by a background sweep
-- (messageEmbedding.service.ts) that embeds ONLY content_redacted (never raw
-- content) with text-embedding-3-small (1536 dims — must match
-- EMBEDDING_DIMENSIONS in embeddings.service.ts). Vectors survive the
-- content-retention wipe (which nulls messages.content only), so long-term
-- research analyses run on redacted-text embeddings by construction.
--
-- Partial HNSW index: only embedded rows participate; NULL rows (unredacted,
-- system/tool roles, sandbox) cost nothing.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE messages ADD COLUMN embedding VECTOR(1536);

CREATE INDEX idx_messages_embedding_hnsw
  ON messages USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
