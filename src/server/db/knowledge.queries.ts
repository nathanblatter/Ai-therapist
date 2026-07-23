// Data access for the psychoeducation RAG knowledge base (pgvector). The
// knowledge_chunks table + vector index are created by migration 031; the corpus
// is loaded by scripts/ingestKnowledge.js. pgvector params are passed as a
// bracketed string cast to ::vector, since node-postgres has no native vector type.
import { pool } from '../config/db.js';

export interface KnowledgeChunk {
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  topic: string | null;
  similarity: number;
}

/** Serialize a JS number[] into a pgvector literal, e.g. [0.12,-0.03,...]. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Cosine-nearest active chunks to a query embedding, optionally filtered to a
 * topic. Returns similarity in [0,1] (1 = identical direction).
 */
export async function searchKnowledgeChunks(
  embedding: number[],
  topic: string | null,
  limit: number,
): Promise<KnowledgeChunk[]> {
  const vec = toVectorLiteral(embedding);
  const result = await pool.query<KnowledgeChunk>(
    `SELECT title, content, source, source_url, topic,
            1 - (embedding <=> $1::vector) AS similarity
     FROM knowledge_chunks
     WHERE active IS TRUE
       AND embedding IS NOT NULL
       AND ($2::text IS NULL OR topic = $2)
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vec, topic, limit],
  );
  return result.rows;
}

export interface KnowledgeChunkInput {
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  content_hash: string;
  embedding: number[];
}

/** Insert or update a chunk (idempotent by content_hash). Used by the ingest script. */
export async function upsertKnowledgeChunk(chunk: KnowledgeChunkInput): Promise<void> {
  const vec = toVectorLiteral(chunk.embedding);
  await pool.query(
    `INSERT INTO knowledge_chunks
       (topic, title, content, source, source_url, license, content_hash, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
     ON CONFLICT (content_hash) DO UPDATE SET
       topic = EXCLUDED.topic,
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       source = EXCLUDED.source,
       source_url = EXCLUDED.source_url,
       license = EXCLUDED.license,
       embedding = EXCLUDED.embedding,
       updated_at = CURRENT_TIMESTAMP`,
    [chunk.topic, chunk.title, chunk.content, chunk.source, chunk.source_url, chunk.license, chunk.content_hash, vec],
  );
}
