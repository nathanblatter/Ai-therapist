// Data access for the RAG knowledge base (pgvector). knowledge_chunks holds
// multiple kinds of content — psychoeducation prose, worksheets, and modality
// techniques — created by migrations 031/032 and loaded by scripts/ingestKnowledge.js.
// pgvector params are passed as a bracketed string cast to ::vector, since
// node-postgres has no native vector type.
import { pool } from '../config/db.js';

export interface KnowledgeChunk {
  chunk_id: number;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  topic: string | null;
  kind: string;
  modality: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
  active?: boolean;
}

export interface KnowledgeFilter {
  topic?: string | null;
  kind?: string | null;
  modality?: string | null;
}

export interface KnowledgeSearchOptions {
  /** Admin-only escape hatch (test-retrieval playground): also match pending
   *  (active=false) chunks. Live retrieval paths never set this. */
  includeInactive?: boolean;
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
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeChunk[]> {
  const vec = toVectorLiteral(embedding);
  const result = await pool.query<KnowledgeChunk>(
    `SELECT chunk_id, title, content, source, source_url, topic, kind, modality, metadata, active,
            1 - (embedding <=> $1::vector) AS similarity
     FROM knowledge_chunks
     WHERE ($6::boolean IS TRUE OR active IS TRUE)
       AND embedding IS NOT NULL
       AND ($2::text IS NULL OR kind = $2)
       AND ($3::text IS NULL OR topic = $3)
       AND ($4::text IS NULL OR modality = $4)
     ORDER BY embedding <=> $1::vector
     LIMIT $5`,
    [vec, filter.kind ?? null, filter.topic ?? null, filter.modality ?? null, limit, options.includeInactive === true],
  );
  return result.rows;
}

export interface KnowledgeChunkTemplate {
  chunk_id: number;
  kind: string;
  title: string | null;
  content: string;
  source: string;
  active: boolean;
  metadata: Record<string, unknown> | null;
}

/** Fetch a single chunk by id (create_custom_worksheet uses this to validate
 *  a personalized worksheet against its vetted template's structure). */
export async function getKnowledgeChunkById(chunkId: number): Promise<KnowledgeChunkTemplate | null> {
  const result = await pool.query<KnowledgeChunkTemplate>(
    `SELECT chunk_id, kind, title, content, source, active, metadata
     FROM knowledge_chunks WHERE chunk_id = $1`,
    [chunkId],
  );
  return result.rows[0] ?? null;
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
  /** Whether this chunk is retrievable. New content is ingested as false
   *  (pending approval); an approval flips it true. Only applied on INSERT —
   *  re-ingesting an existing chunk never overwrites its approval state. */
  active: boolean;
}

/** Insert or update a chunk (idempotent by content_hash). Used by the ingest script.
 *  NOTE: `active` is set only on first insert; ON CONFLICT deliberately does NOT
 *  touch it, so re-running ingest never un-approves content you've approved. */
export async function upsertKnowledgeChunk(chunk: KnowledgeChunkInput): Promise<void> {
  const vec = toVectorLiteral(chunk.embedding);
  await pool.query(
    `INSERT INTO knowledge_chunks
       (topic, title, content, source, source_url, license, kind, modality, metadata, content_hash, embedding, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12)
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
      chunk.content_hash, vec, chunk.active,
    ],
  );
}

export interface KnowledgeStatusCounts {
  kind: string;
  active: number;
  pending: number;
}

/** Approve chunks (active=true) by kind/topic, or all pending. Returns rows changed.
 *  Stamps approver identity + optional note (ai-therapist-88 audit trail). */
export async function approveKnowledgeChunks(
  filter: { kind?: string | null; topic?: string | null },
  actor: string,
  note?: string | null,
): Promise<number> {
  const result = await pool.query(
    `UPDATE knowledge_chunks
     SET active = TRUE,
         approved_by = $3,
         approved_at = CURRENT_TIMESTAMP,
         approval_note = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE active IS NOT TRUE
       AND ($1::text IS NULL OR kind = $1)
       AND ($2::text IS NULL OR topic = $2)`,
    [filter.kind ?? null, filter.topic ?? null, actor, note ?? null],
  );
  return result.rowCount ?? 0;
}

/** Preview what approveKnowledgeChunks(filter) would affect, without writing
 *  (ai-therapist-77: --dry-run for approveKnowledge.js). */
export async function previewPendingKnowledgeChunks(
  filter: { kind?: string | null; topic?: string | null }
): Promise<{ kind: string; topic: string | null; title: string | null }[]> {
  const result = await pool.query<{ kind: string; topic: string | null; title: string | null }>(
    `SELECT kind, topic, title
     FROM knowledge_chunks
     WHERE active IS NOT TRUE
       AND ($1::text IS NULL OR kind = $1)
       AND ($2::text IS NULL OR topic = $2)
     ORDER BY kind, topic, title`,
    [filter.kind ?? null, filter.topic ?? null],
  );
  return result.rows;
}

/** Counts of active vs pending chunks per kind (for the approval workflow). */
export async function getKnowledgeStatusCounts(): Promise<KnowledgeStatusCounts[]> {
  const result = await pool.query<KnowledgeStatusCounts>(
    `SELECT kind,
            COUNT(*) FILTER (WHERE active IS TRUE)::int AS active,
            COUNT(*) FILTER (WHERE active IS NOT TRUE)::int AS pending
     FROM knowledge_chunks GROUP BY kind ORDER BY kind`,
  );
  return result.rows;
}

// ---- Admin curation (the Knowledge Base UI) ----

export interface KnowledgeChunkAdmin {
  chunk_id: number;
  kind: string;
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  modality: string | null;
  active: boolean;
  approved_by: string | null;
  approved_at: Date | null;
  approval_note: string | null;
  created_at: Date;
  updated_at: Date | null;
  /** Provenance flag: chunks without an embedding can never be retrieved. */
  has_embedding: boolean;
}

export interface KnowledgeListFilter {
  kind?: string | null;
  active?: boolean | null;
  /** Case-insensitive substring match over title/content/topic/source. */
  q?: string | null;
  limit?: number;
  offset?: number;
}

export interface KnowledgeListResult {
  chunks: KnowledgeChunkAdmin[];
  /** Total rows matching the filter (ignoring limit/offset), for paging. */
  total: number;
}

/** List chunks for the admin curation view (no embedding payload), pending
 *  first, with optional text search and limit/offset paging. */
export async function listKnowledgeChunks(filter: KnowledgeListFilter): Promise<KnowledgeListResult> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const q = filter.q && filter.q.trim() ? `%${filter.q.trim()}%` : null;
  const result = await pool.query<KnowledgeChunkAdmin & { total_count: string | number }>(
    `SELECT chunk_id, kind, topic, title, content, source, source_url, license, modality, active,
            approved_by, approved_at, approval_note, created_at, updated_at,
            (embedding IS NOT NULL) AS has_embedding,
            COUNT(*) OVER() AS total_count
     FROM knowledge_chunks
     WHERE ($1::text IS NULL OR kind = $1)
       AND ($2::boolean IS NULL OR active = $2)
       AND ($3::text IS NULL OR title ILIKE $3 OR content ILIKE $3 OR topic ILIKE $3 OR source ILIKE $3)
     ORDER BY active ASC, kind, topic NULLS FIRST, title
     LIMIT $4 OFFSET $5`,
    [filter.kind ?? null, filter.active ?? null, q, limit, offset],
  );
  const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const chunks = result.rows.map(({ total_count: _ignored, ...row }) => row);
  return { chunks, total };
}

export interface CreateKnowledgeChunkInput {
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  kind: string;
  modality: string | null;
  content_hash: string;
  embedding: number[];
}

/** Insert a new admin-authored chunk as pending review (active=false).
 *  Returns the new chunk_id, or null if identical content already exists
 *  (content_hash is UNIQUE — we refuse rather than silently overwrite). */
export async function createKnowledgeChunk(input: CreateKnowledgeChunkInput): Promise<number | null> {
  const vec = toVectorLiteral(input.embedding);
  const result = await pool.query<{ chunk_id: number }>(
    `INSERT INTO knowledge_chunks
       (topic, title, content, source, source_url, license, kind, modality, content_hash, embedding, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, FALSE)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING chunk_id`,
    [
      input.topic, input.title, input.content, input.source, input.source_url,
      input.license, input.kind, input.modality, input.content_hash, vec,
    ],
  );
  return result.rows[0]?.chunk_id ?? null;
}

export interface UpdateKnowledgeChunkInput {
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  kind: string;
  modality: string | null;
  /** Present only when content changed: new hash + fresh embedding. The update
   *  then also resets active=false so edited clinical content re-clears review. */
  contentChange?: { content_hash: string; embedding: number[] } | null;
}

/** Update a chunk's editable fields. When contentChange is provided the
 *  content_hash + embedding are replaced and the chunk goes back to pending
 *  (active=false). Returns false if the id doesn't exist. */
export async function updateKnowledgeChunk(chunkId: number, input: UpdateKnowledgeChunkInput): Promise<boolean> {
  const change = input.contentChange ?? null;
  const r = change
    ? await pool.query(
        `UPDATE knowledge_chunks
         SET topic = $2, title = $3, content = $4, source = $5, source_url = $6,
             license = $7, kind = $8, modality = $9,
             content_hash = $10, embedding = $11::vector,
             active = FALSE,
             updated_at = CURRENT_TIMESTAMP
         WHERE chunk_id = $1`,
        [
          chunkId, input.topic, input.title, input.content, input.source, input.source_url,
          input.license, input.kind, input.modality,
          change.content_hash, toVectorLiteral(change.embedding),
        ],
      )
    : await pool.query(
        `UPDATE knowledge_chunks
         SET topic = $2, title = $3, content = $4, source = $5, source_url = $6,
             license = $7, kind = $8, modality = $9,
             updated_at = CURRENT_TIMESTAMP
         WHERE chunk_id = $1`,
        [
          chunkId, input.topic, input.title, input.content, input.source, input.source_url,
          input.license, input.kind, input.modality,
        ],
      );
  return (r.rowCount ?? 0) > 0;
}

/** Approve/unapprove a single chunk. Returns false if the id doesn't exist.
 *  On approve (active=true) the approver identity + timestamp + optional note
 *  are recorded; on unapprove (active=false) those fields are deliberately left
 *  intact so `active=false` + populated approval reads as "approved then revoked"
 *  (ai-therapist-88 audit trail). */
export async function setKnowledgeChunkActive(
  chunkId: number,
  active: boolean,
  actor: string,
  note?: string | null,
): Promise<boolean> {
  const r = active
    ? await pool.query(
        `UPDATE knowledge_chunks
         SET active = TRUE,
             approved_by = $2,
             approved_at = CURRENT_TIMESTAMP,
             approval_note = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE chunk_id = $1`,
        [chunkId, actor, note ?? null],
      )
    : await pool.query(
        `UPDATE knowledge_chunks SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE chunk_id = $1`,
        [chunkId],
      );
  return (r.rowCount ?? 0) > 0;
}

/** Permanently delete a chunk. Returns false if the id doesn't exist. */
export async function deleteKnowledgeChunk(chunkId: number): Promise<boolean> {
  const r = await pool.query(`DELETE FROM knowledge_chunks WHERE chunk_id = $1`, [chunkId]);
  return (r.rowCount ?? 0) > 0;
}
