-- Migration: Psychoeducation knowledge base for grounded RAG tool-calling
-- Date: 2026-07-22
--
-- Backs the retrieve_psychoeducation tool: vetted, evidence-based passages with
-- full provenance (source/url/license) and a pgvector embedding for cosine
-- retrieval. Corpus is loaded separately by scripts/ingestKnowledge.js.
-- Requires pgvector (already enabled on this Postgres).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    chunk_id      BIGSERIAL PRIMARY KEY,
    topic         TEXT,                        -- coarse category: 'depression', 'anxiety', 'coping', ...
    title         TEXT,                        -- short human-readable title
    content       TEXT NOT NULL,               -- the passage the model grounds on
    source        TEXT NOT NULL,               -- e.g. 'National Institute of Mental Health (NIMH)'
    source_url    TEXT,                        -- provenance link
    license       TEXT,                        -- e.g. 'Public Domain (U.S. NIMH)'
    content_hash  TEXT UNIQUE NOT NULL,        -- md5(content); makes ingest idempotent
    embedding     VECTOR(1536),                -- text-embedding-3-small; NULL until ingested
    active        BOOLEAN DEFAULT TRUE,        -- soft-disable a passage without deleting it
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge_chunks(topic);

-- Cosine ANN index for fast nearest-neighbour retrieval (pgvector >= 0.5.0).
-- If your pgvector is older, drop this statement — exact search still works.
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
    ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

COMMENT ON TABLE knowledge_chunks IS 'Vetted, evidence-based psychoeducation passages for RAG (retrieve_psychoeducation tool)';
COMMENT ON COLUMN knowledge_chunks.content_hash IS 'md5 of content; ON CONFLICT target so re-ingest is idempotent';
