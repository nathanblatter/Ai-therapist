// Researcher semantic search over REDACTED transcript text (ai-therapist-177):
// "sessions discussing sleep problems" for qualitative sampling and
// safety-review triage.
//
// Ranking uses messages.embedding (migration 085), which the background sweep
// (messageEmbedding.service.ts) computes from content_redacted only, never raw
// content. Same model, dimensions and distance operator as the sweep and the
// knowledge-base RAG: text-embedding-3-small, VECTOR(1536), cosine (<=>), so
// the partial HNSW index idx_messages_embedding_hnsw (vector_cosine_ops)
// drives study-wide searches (plan notes on semanticSearchSql).
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
import { leakCheckNeedsReviewSql } from './leakCheckSql.js';

/**
 * The per-message "redaction is complete" predicate for search results.
 *
 *   - role is a participant/model turn ('user' | 'assistant'), the only rows
 *     the embedding sweep embeds;
 *   - content_redacted holds non-blank text (the batch job has written it, or
 *     a researcher hand-redacted it);
 *   - no redaction_error is recorded against the row (a failed or partial
 *     run; the same exclusion the content-wipe sweep uses);
 *   - the leak check (redactionVerifier, ai-therapist-262) has neither
 *     flagged it as still containing an identifier nor errored on it
 *     (ai-therapist-288: an unverified row is not a clean row), unless a
 *     researcher has since reviewed it in the /redact tool.
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
    AND NOT ${leakCheckNeedsReviewSql(alias)})`;
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

/**
 * Candidate pool for study-wide searches: the nearest this-many embedded
 * messages, which the redaction, org and date predicates then filter. Also
 * used as hnsw.ef_search, since an HNSW scan without iterative scans never
 * yields more than ef_search rows. 4x the page window, at least 200, at most
 * pgvector's 1000.
 */
export function semanticSearchCandidates(limit: number, offset: number): number {
  return Math.min(1000, Math.max(200, (limit + offset + 1) * 4));
}

export type SemanticSearchMode = 'index' | 'exact';

// Shared SELECT list + filters. Parameters: $1 query vector, $2 org,
// $3 session, $4 from, $5 to, $6 max cosine distance, $7 limit (+1 for
// hasMore), $8 offset, and in index mode $9 candidate pool size.
function selectAndFilters(distanceExpr: string, fromClause: string): string {
  return `
  SELECT m.message_id::text AS message_id,
         m.session_id AS session_id,
         m.role,
         m.content_redacted AS redacted_text,
         m.created_at::text AS created_at,
         1 - ${distanceExpr} AS similarity,
         ts.session_name,
         ts.created_at::text AS session_started_at,
         ts.user_id AS owner_user_id
    ${fromClause}
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
     AND ${distanceExpr} <= $6::float8
   ORDER BY ${distanceExpr}
   LIMIT $7 OFFSET $8`;
}

/**
 * The search statement for a mode.
 *
 * Query plan (checked with EXPLAIN ANALYZE on a 30k-message scratch database):
 * one statement with the redaction predicate inline gets a badly low row
 * estimate on messages (the jsonb and btrim conditions multiply default
 * selectivities: about 50 rows estimated against about 15,000 actual), which
 * makes the HNSW index look like it must be walked to the end, so the planner
 * would never pick it however large the table grows. Hence two shapes:
 *   - 'index' (study-wide): a MATERIALIZED candidate CTE that orders ONLY by
 *     distance under the partial index's own predicate (embedding IS NOT
 *     NULL) with a small LIMIT, the shape idx_messages_embedding_hnsw is
 *     costed for; every other predicate filters the pool. The planner still
 *     chooses: on a small table an exact top-N sort is cheaper and is used,
 *     and the index takes over as the table grows. Recall is bounded by the
 *     pool, the same bound an HNSW scan without iterative scans imposes.
 *   - 'exact' (one session): the session_id index finds the session's rows and
 *     they are ranked exactly, with no pool bound.
 * No new index is added.
 *
 * Built on call, not at import: modules that mock organizations.queries
 * partially must still be able to import the db barrel.
 */
export function semanticSearchSql(mode: SemanticSearchMode): string {
  if (mode === 'exact') {
    return selectAndFilters('(m.embedding <=> $1::vector)', 'FROM messages m');
  }
  return `
  WITH candidates AS MATERIALIZED (
    SELECT c.message_id, c.embedding <=> $1::vector AS distance
      FROM messages c
     WHERE c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $9
  )${selectAndFilters('cand.distance', 'FROM candidates cand\n    JOIN messages m ON m.message_id = cand.message_id')}`;
}

/**
 * Rank redacted messages in the caller's organization by cosine similarity to
 * a query embedding. Read-only transaction so SET LOCAL scopes the ef_search
 * bump to this one checkout.
 */
export async function searchRedactedMessages(params: SemanticSearchParams): Promise<SemanticSearchPage> {
  const limit = Math.max(1, Math.floor(params.limit));
  const offset = Math.max(0, Math.floor(params.offset));
  if (limit + offset > SEMANTIC_SEARCH_MAX_WINDOW) {
    throw new Error(`semantic search window exceeds ${SEMANTIC_SEARCH_MAX_WINDOW}`);
  }
  const minSimilarity = Math.min(1, Math.max(0, params.minSimilarity));
  const mode: SemanticSearchMode = params.sessionId ? 'exact' : 'index';
  const values: unknown[] = [
    toVectorLiteral(params.embedding),
    params.orgId,
    params.sessionId ?? null,
    params.from ?? null,
    params.to ?? null,
    1 - minSimilarity,
    limit + 1,
    offset,
  ];
  const candidates = semanticSearchCandidates(limit, offset);
  if (mode === 'index') values.push(candidates);

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    if (mode === 'index') await client.query(`SET LOCAL hnsw.ef_search = ${candidates}`);
    const result = await client.query<HitRow>(semanticSearchSql(mode), values);
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
