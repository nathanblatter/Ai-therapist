-- Rollback for 031_knowledge_base.sql
-- Drops the knowledge base table + indexes. Leaves the pgvector extension in
-- place (other features may rely on it).

DROP TABLE IF EXISTS knowledge_chunks;
