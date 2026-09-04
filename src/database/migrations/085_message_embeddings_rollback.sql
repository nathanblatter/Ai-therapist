-- Rollback for 085: drop the message embedding column and its index.
DROP INDEX IF EXISTS idx_messages_embedding_hnsw;
ALTER TABLE messages DROP COLUMN IF EXISTS embedding;
