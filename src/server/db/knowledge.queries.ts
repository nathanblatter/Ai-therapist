// Data access for the RAG knowledge base (pgvector). knowledge_chunks holds
// multiple kinds of content — psychoeducation prose, worksheets, and modality
// techniques — created by migrations 031/032 and loaded by scripts/ingestKnowledge.js.
// pgvector params are passed as a bracketed string cast to ::vector, since
// node-postgres has no native vector type.
import { pool } from '../config/db.js';

export interface KnowledgeChunk {
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  topic: string | null;
  kind: string;
  modality: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
}

export interface KnowledgeFilter {
  topic?: string | null;
  kind?: string | null;
  modality?: string | null;
}

/** Serialize a JS number[] into a pgvector literal, e.g. [0.12,-0.03,...]. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Cosine-nearest active chunks to a query embedding, optionally filtered by
 * kind / topic / modality. Similarity is in [0,1] (1 = identical direction).
 */
export async function searchKnowledgeChunks(
  embedding: number[],
  filter: KnowledgeFilter,
  limit: number,
): Promise<KnowledgeChunk[]> {
  const vec = toVectorLiteral(embedding);
  const result = await pool.query<KnowledgeChunk>(
    `SELECT title, content, source, source_url, topic, kind, modality, metadata,
            1 - (embedding <=> $1::vector) AS similarity
     FROM knowledge_chunks
     WHERE active IS TRUE
       AND embedding IS NOT NULL
       AND ($2::text IS NULL OR kind = $2)
       AND ($3::text IS NULL OR topic = $3)
       AND ($4::text IS NULL OR modality = $4)
     ORDER BY embedding <=> $1::vector
     LIMIT $5`,
    [vec, filter.kind ?? null, filter.topic ?? null, filter.modality ?? null, limit],
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
  kind: string;
  modality: string | null;
  metadata: Record<string, unknown> | null;
  content_hash: string;
  embedding: number[];
}

/** Insert or update a chunk (idempotent by content_hash). Used by the ingest script. */
export async function upsertKnowledgeChunk(chunk: KnowledgeChunkInput): Promise<void> {
  const vec = toVectorLiteral(chunk.embedding);
  await pool.query(
    `INSERT INTO knowledge_chunks
       (topic, title, content, source, source_url, license, kind, modality, metadata, content_hash, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
     ON CONFLICT (content_hash) DO UPDATE SET
       topic = EXCLUDED.topic,
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       source = EXCLUDED.source,
       source_url = EXCLUDED.source_url,
       license = EXCLUDED.license,
       kind = EXCLUDED.kind,
       modality = EXCLUDED.modality,
       metadata = EXCLUDED.metadata,
       embedding = EXCLUDED.embedding,
       updated_at = CURRENT_TIMESTAMP`,
    [
      chunk.topic, chunk.title, chunk.content, chunk.source, chunk.source_url, chunk.license,
      chunk.kind, chunk.modality, chunk.metadata ? JSON.stringify(chunk.metadata) : null,
      chunk.content_hash, vec,
    ],
  );
}
