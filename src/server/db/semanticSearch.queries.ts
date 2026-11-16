// Researcher semantic search over REDACTED transcript text (ai-therapist-177):
// "sessions discussing sleep problems" for qualitative sampling and
// safety-review triage.
//
// Ranking uses messages.embedding (migration 085), which the background sweep
// (messageEmbedding.service.ts) computes from content_redacted only, never raw
// content. Same model, dimensions and distance operator as the sweep and the
// knowledge-base RAG: text-embedding-3-small, VECTOR(1536), cosine (<=>), so
// the partial HNSW index idx_messages_embedding_hnsw (vector_cosine_ops) can
// drive the ORDER BY.
//
// Redacted-only, structurally:
//   1. The only text column this module ever selects is content_redacted. No
//      query here names messages.content or messages.metadata (a test pins it).
//   2. Every hit must satisfy redactionCompleteSql(): the per-message
//      definition of "redaction finished and nothing outstanding against it".
//   3. Rows leave this module through toHit(), an explicit field-by-field
//      projection, so a widened SELECT still cannot carry a raw column out.
import { pool } from '../config/db.js';
import { ownerOrgScopeSql } from './organizations.queries.js';
import { toVectorLiteral } from './knowledge.queries.js';

/**
 * The per-message "redaction is complete" predicate for search results.
 *
 *   - role is a participant/model turn ('user' | 'assistant'), the only rows
 *     the embedding sweep embeds;
 *   - content_redacted holds non-blank text (the batch job has written it, or
 *     a researcher hand-redacted it);
 *   - no redaction_error is recorded against the row (a failed or partial
 *     run; the same exclusion the content-wipe sweep uses);
 *   - the leak check (redactionVerifier, ai-therapist-262) has not flagged it
 *     as still containing an identifier, unless a researcher has since
 *     reviewed it in the /redact tool.
 *
 * Message-level only. The session-level guard (status <> 'active') lives in
 * the search query, because a researcher reading an ACTIVE session's
 * transcript is served raw content (live-monitoring exemption) and the result
 * link must never open that view.
 */
export function redactionCompleteSql(alias = 'm'): string {
  const q = `${alias}.`;
  return `(${q}role IN ('user', 'assistant')
    AND ${q}content_redacted IS NOT NULL
    AND btrim(${q}content_redacted) <> ''
    AND (${q}metadata->>'redaction_error') IS NULL
    AND NOT (COALESCE(${q}metadata->'redaction_check'->>'flagged', 'false') = 'true'
             AND COALESCE(${q}metadata->'redaction_check'->>'reviewed', 'false') <> 'true'))`;
}

/** Largest offset + limit a search may page to (bounds hnsw.ef_search). */
export const SEMANTIC_SEARCH_MAX_WINDOW = 200;

export interface SemanticSearchParams {
  /** Query embedding (EMBEDDING_DIMENSIONS floats). */
  embedding: number[];
  /** The researcher's organization (orgIdFor). Required: results never cross it. */
  orgId: number;
  /** Restrict to one therapy session id. */
  sessionId?: string | null;
  /** ISO timestamps on the message's created_at: inclusive lower, exclusive upper. */
  from?: string | null;
  to?: string | null;
  /** Cosine-similarity floor in [0, 1]; hits below it are dropped. */
  minSimilarity: number;
  limit: number;
  offset: number;
}

/** One ranked message. `text` is content_redacted and nothing else. */
export interface SemanticSearchHit {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  similarity: number;
  sessionName: string | null;
  sessionStartedAt: string | null;
  /** Session owner, for the data_access_log row. Null for anonymous sessions. */
  ownerUserId: number | null;
}

export interface SemanticSearchPage {
  hits: SemanticSearchHit[];
  hasMore: boolean;
}

interface HitRow {
  message_id: string;
  session_id: string;
  role: string;
  redacted_text: string;
  created_at: string;
  similarity: string | number;
  session_name: string | null;
  session_started_at: string | null;
  owner_user_id: number | string | null;
}

/** Explicit projection: the only path a row takes out of this module. */
function toHit(row: HitRow): SemanticSearchHit {
  return {
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    text: String(row.redacted_text),
    createdAt: String(row.created_at),
    similarity: Number(row.similarity),
    sessionName: row.session_name ?? null,
    sessionStartedAt: row.session_started_at ?? null,
    ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id),
  };
}

// $1 query vector, $2 org, $3 session, $4 from, $5 to, $6 max cosine distance,
// $7 limit (+1 for hasMore), $8 offset.
//
// Query plan: ORDER BY embedding <=> $1 with LIMIT lets the planner use the
// partial HNSW index (its predicate, embedding IS NOT NULL, is repeated here so
// the index qualifies); the remaining predicates filter the index's candidate
// stream. HNSW without iterative scans yields at most hnsw.ef_search
// candidates, so the caller raises ef_search for the page being read. A narrow
// filter (one session, a short date range) is usually cheaper as an exact scan
// via idx_messages_session_id / idx_messages_created_at, which the planner is
// free to pick. No new index is added.
//
// Built on call, not at import: modules that mock organizations.queries
// partially must still be able to import the db barrel.
export function semanticSearchSql(): string {
  return `
  SELECT m.message_id::text AS message_id,
         m.session_id AS session_id,
         m.role,
         m.content_redacted AS redacted_text,
         m.created_at::text AS created_at,
         1 - (m.embedding <=> $1::vector) AS similarity,
         ts.session_name,
         ts.created_at::text AS session_started_at,
         ts.user_id AS owner_user_id
    FROM messages m
    JOIN therapy_sessions ts ON ts.session_id = m.session_id
    LEFT JOIN users u ON u.userid = ts.user_id
   WHERE m.embedding IS NOT NULL
     AND ${redactionCompleteSql('m')}
     AND ts.status <> 'active'
     AND ts.is_demo IS NOT TRUE
     AND u.is_sandbox IS NOT TRUE
     AND ${ownerOrgScopeSql('$2::int', 'ts.user_id')}
     AND ($3::text IS NULL OR m.session_id = $3::text)
     AND ($4::timestamptz IS NULL OR m.created_at >= $4::timestamptz)
     AND ($5::timestamptz IS NULL OR m.created_at < $5::timestamptz)
     AND (m.embedding <=> $1::vector) <= $6::float8
   ORDER BY m.embedding <=> $1::vector
   LIMIT $7 OFFSET $8`;
}

/**
 * Rank redacted messages in the caller's organization by cosine similarity to
 * a query embedding. Read-only transaction so SET LOCAL scopes the ef_search
 * bump to this one statement's connection checkout.
 */
export async function searchRedactedMessages(params: SemanticSearchParams): Promise<SemanticSearchPage> {
  const limit = Math.max(1, Math.floor(params.limit));
  const offset = Math.max(0, Math.floor(params.offset));
  if (limit + offset > SEMANTIC_SEARCH_MAX_WINDOW) {
    throw new Error(`semantic search window exceeds ${SEMANTIC_SEARCH_MAX_WINDOW}`);
  }
  const minSimilarity = Math.min(1, Math.max(0, params.minSimilarity));
  // Candidates the index must surface so post-filtering can still fill the
  // page: a 4x margin over the window, inside pgvector's 1..1000 range.
  const efSearch = Math.min(1000, Math.max(100, (limit + offset + 1) * 4));

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    const result = await client.query<HitRow>(semanticSearchSql(), [
      toVectorLiteral(params.embedding),
      params.orgId,
      params.sessionId ?? null,
      params.from ?? null,
      params.to ?? null,
      1 - minSimilarity,
      limit + 1,
      offset,
    ]);
    await client.query('COMMIT');
    const rows = result.rows;
    return { hits: rows.slice(0, limit).map(toHit), hasMore: rows.length > limit };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
