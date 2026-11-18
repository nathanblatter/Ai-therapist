// Researcher semantic search over redacted transcripts (ai-therapist-177):
// POST /admin/api/semantic-search ranks redacted messages by meaning ("sessions
// discussing sleep problems") for qualitative sampling and safety-review
// triage. Results carry content_redacted only; see db/semanticSearch.queries.ts
// for the structural guarantees.
//
// Access: researcher only, organization-scoped in SQL (the same rule as every
// researcher transcript read, ai-therapist-269/272). Therapists are excluded
// rather than caseload-scoped: their transcript tier is raw content of assigned
// clients, and a cross-participant research search is the same shape as bulk
// export, which is researcher-only. Caseworkers (summaries tier) and demo
// accounts never reach it.
//
// Cost and egress: one embeddings call per search (text-embedding-3-small via
// embeddings.service, the same function and data-handling settings as the
// message-embedding sweep and the knowledge-base RAG; the embeddings endpoint
// has no `store` option). The researcher's QUERY TEXT is therefore sent to
// OpenAI. Paging re-uses a short-lived in-memory copy of the query vector, and
// the endpoint is rate-limited per user.
//
// Audit: every search writes data_access_log rows (action 'semantic_search')
// in the transcript_view shape: one per session that had messages returned
// (session_id + participant user_id), with the query text and returned
// message ids in detail; one session-less row when nothing matched.
import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { logDataAccess, searchRedactedMessages, SEMANTIC_SEARCH_MAX_WINDOW } from '../../db/index.js';
import { embedText } from '../../services/embeddings.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('semanticSearchRoutes');

export const QUERY_MIN_CHARS = 3;
export const QUERY_MAX_CHARS = 500;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
/** text-embedding-3-small cosine similarity between related short texts sits
 *  roughly in 0.3-0.6; 0.3 drops the unrelated tail without hiding paraphrase. */
export const DEFAULT_MIN_SIMILARITY = 0.3;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface ParsedSearch {
  query: string;
  sessionId: string | null;
  from: string | null;
  to: string | null;
  minSimilarity: number;
  limit: number;
  offset: number;
}

function parseTimestamp(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

function parseIntField(raw: unknown, fallback: number): number | undefined {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/** Validate the request body; a string is the 400 message. */
export function parseSearchBody(body: unknown): ParsedSearch | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const query = typeof b.query === 'string' ? b.query.trim() : '';
  if (query.length < QUERY_MIN_CHARS || query.length > QUERY_MAX_CHARS) {
    return `query must be ${QUERY_MIN_CHARS}-${QUERY_MAX_CHARS} characters`;
  }

  let sessionId: string | null = null;
  if (b.sessionId !== undefined && b.sessionId !== null && b.sessionId !== '') {
    if (typeof b.sessionId !== 'string' || !SESSION_ID_RE.test(b.sessionId.trim())) return 'invalid sessionId';
    sessionId = b.sessionId.trim();
  }

  const from = parseTimestamp(b.from);
  const to = parseTimestamp(b.to);
  if (from === undefined || to === undefined) return 'from/to must be ISO-8601 timestamps';
  if (from && to && from >= to) return 'from must be before to';

  let minSimilarity = DEFAULT_MIN_SIMILARITY;
  if (b.minSimilarity !== undefined && b.minSimilarity !== null && b.minSimilarity !== '') {
    const n = Number(b.minSimilarity);
    if (!Number.isFinite(n) || n < 0 || n > 1) return 'minSimilarity must be between 0 and 1';
    minSimilarity = n;
  }

  const limit = parseIntField(b.limit, DEFAULT_LIMIT);
  const offset = parseIntField(b.offset, 0);
  if (limit === undefined || limit < 1 || limit > MAX_LIMIT) return `limit must be 1-${MAX_LIMIT}`;
  if (offset === undefined || offset < 0) return 'offset must be a non-negative integer';
  if (limit + offset > SEMANTIC_SEARCH_MAX_WINDOW) {
    return `results are capped at the top ${SEMANTIC_SEARCH_MAX_WINDOW}; narrow the search instead of paging further`;
  }

  return { query, sessionId, from, to, minSimilarity, limit, offset };
}

// Query-vector cache: "Load more" re-sends the same query, which would
// otherwise cost a second embeddings call. Keyed by user so one researcher's
// query text never answers another's request; bounded and short-lived.
const VECTOR_TTL_MS = 10 * 60_000;
const VECTOR_CACHE_MAX = 200;
const vectorCache = new Map<string, { vec: number[]; at: number }>();

async function embedQuery(userId: number, query: string): Promise<number[]> {
  const key = `${userId}\u0000${query}`;
  const now = Date.now();
  const hit = vectorCache.get(key);
  if (hit && now - hit.at < VECTOR_TTL_MS) return hit.vec;
  const vec = await embedText(query);
  if (vectorCache.size >= VECTOR_CACHE_MAX) {
    const oldest = vectorCache.keys().next().value;
    if (oldest !== undefined) vectorCache.delete(oldest);
  }
  vectorCache.set(key, { vec, at: now });
  return vec;
}

/** Test hook: forget cached query vectors. */
export function clearQueryVectorCache(): void {
  vectorCache.clear();
}

export default function semanticSearchRoutes(): Router {
  const router = Router();

  // Per user, not per IP: one researcher cannot exhaust a shared clinic
  // network's budget, and each request is at most one embeddings call.
  const searchLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `user:${req.session?.userId ?? 'anon'}`,
    message: { error: 'Search rate limit reached. Please wait a few minutes.' },
  });

  router.post('/admin/api/semantic-search', requireRole('researcher'), searchLimiter, async (req, res) => {
    const parsed = parseSearchBody(req.body);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });

    const userId = req.session.userId!;
    try {
      // Fail closed: orgIdFor throws on a lookup failure (-> 500), never
      // widening a researcher to all organizations.
      const orgId = await orgIdFor(req);
      if (orgId === null) return res.status(401).json({ error: 'Authentication required' });

      let embedding: number[];
      try {
        embedding = await embedQuery(userId, parsed.query);
      } catch (err) {
        // The error text can echo the request; never log the query itself.
        log.error({ err: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, 'query embedding failed');
        return res.status(502).json({ error: 'Search is unavailable right now. Try again shortly.' });
      }

      const page = await searchRedactedMessages({
        embedding,
        orgId,
        sessionId: parsed.sessionId,
        from: parsed.from,
        to: parsed.to,
        minSimilarity: parsed.minSimilarity,
        limit: parsed.limit,
        offset: parsed.offset,
      });

      // Access audit (091, fire-and-forget), transcript_view shape: who saw
      // which session's redacted text, plus the query that surfaced it.
      const filters = {
        sessionId: parsed.sessionId,
        from: parsed.from,
        to: parsed.to,
        minSimilarity: parsed.minSimilarity,
        limit: parsed.limit,
        offset: parsed.offset,
      };
      const bySession = new Map<string, { ownerUserId: number | null; messageIds: string[] }>();
      for (const hit of page.hits) {
        const entry = bySession.get(hit.sessionId) ?? { ownerUserId: hit.ownerUserId, messageIds: [] };
        entry.messageIds.push(hit.messageId);
        bySession.set(hit.sessionId, entry);
      }
      const base = { accessedBy: userId, role: req.session.userRole ?? null, action: 'semantic_search' as const };
      if (bySession.size === 0) {
        void logDataAccess({
          ...base,
          detail: { query: parsed.query, contentColumn: 'content_redacted', messageIds: [], filters },
        });
      }
      for (const [sessionId, entry] of bySession) {
        void logDataAccess({
          ...base,
          sessionId,
          userId: entry.ownerUserId,
          detail: { query: parsed.query, contentColumn: 'content_redacted', messageIds: entry.messageIds, filters },
        });
      }

      res.json({
        // ownerUserId is for the audit row only; it is not part of the payload.
        hits: page.hits.map((h) => ({
          messageId: h.messageId,
          sessionId: h.sessionId,
          sessionName: h.sessionName,
          sessionStartedAt: h.sessionStartedAt,
          role: h.role,
          text: h.text,
          createdAt: h.createdAt,
          similarity: h.similarity,
        })),
        hasMore: page.hasMore && parsed.offset + parsed.limit < SEMANTIC_SEARCH_MAX_WINDOW,
        nextOffset: parsed.offset + page.hits.length,
      });
    } catch (err) {
      log.error({ err }, 'semantic search failed');
      res.status(500).json({ error: 'Search failed' });
    }
  });

  return router;
}
