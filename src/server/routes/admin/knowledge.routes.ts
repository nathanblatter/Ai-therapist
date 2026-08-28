// Admin curation API for the RAG knowledge base (the Knowledge Base tab).
// Reads are therapist/researcher; mutations (create/edit/approve/unapprove/
// delete) are researcher-only, matching the rest of the config-write surface.
// Retrieval only ever returns active chunks, so this is where content gets
// promoted — and, since ai-therapist-116, where it gets authored and edited.
import crypto from 'crypto';
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listKnowledgeChunks,
  createKnowledgeChunk,
  updateKnowledgeChunk,
  getKnowledgeChunkById,
  setKnowledgeChunkActive,
  deleteKnowledgeChunk,
  approveKnowledgeChunks,
  getKnowledgeStatusCounts,
  searchKnowledgeChunks,
  getChunkRetrievalStats,
  listRerankDecisions,
  getRerankStats,
} from '../../db/index.js';
import { embedText } from '../../services/embeddings.service.js';
import { rerankChunks } from '../../services/rerank.service.js';
import { parsePagination } from '../../utils/pagination.js';

const KINDS = ['psychoeducation', 'worksheet', 'technique'];
const MAX_CONTENT_CHARS = 20_000;

/** Trim an optional approval note and cap it at 500 chars; blank => null. */
function normalizeNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 500);
  return trimmed.length ? trimmed : null;
}

/** Optional short text field: trimmed string or null. */
function optionalText(raw: unknown, maxLen = 500): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, maxLen);
  return trimmed.length ? trimmed : null;
}

interface ChunkBody {
  kind: string;
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  modality: string | null;
}

/** Validate a create/edit body. Returns the normalized fields or an error string. */
function parseChunkBody(body: unknown): { ok: true; value: ChunkBody } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = typeof b.kind === 'string' ? b.kind.trim() : '';
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of: ${KINDS.join(', ')}` };
  }
  const content = typeof b.content === 'string' ? b.content.trim() : '';
  if (!content) return { ok: false, error: 'content is required' };
  if (content.length > MAX_CONTENT_CHARS) {
    return { ok: false, error: `content exceeds ${MAX_CONTENT_CHARS} characters` };
  }
  const source = optionalText(b.source);
  if (!source) return { ok: false, error: 'source is required' };
  const source_url = optionalText(b.source_url, 2000);
  if (source_url && !/^https?:\/\//i.test(source_url)) {
    return { ok: false, error: 'source_url must be an http(s) URL' };
  }
  return {
    ok: true,
    value: {
      kind,
      topic: optionalText(b.topic),
      title: optionalText(b.title),
      content,
      source,
      source_url,
      license: optionalText(b.license),
      modality: optionalText(b.modality, 100),
    },
  };
}

/** content_hash matches the ingest script: md5 hex of the content text. */
function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

export default function knowledgeRoutes(): Router {
  const router = Router();
  const canRead = requireRole('therapist', 'researcher');
  const canWrite = requireRole('researcher');

  // List chunks + status counts, filtered by kind/status, searchable (q over
  // title/content/topic/source) and paged (limit/offset; total for the pager).
  router.get('/admin/api/knowledge', canRead, async (req, res) => {
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
    const status = req.query.status;
    const active = status === 'active' ? true : status === 'pending' ? false : null;
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
    // Same defaults/clamp listKnowledgeChunks applies internally (50/0, max 200).
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    try {
      const [counts, list] = await Promise.all([
        getKnowledgeStatusCounts(),
        listKnowledgeChunks({
          kind,
          active,
          q,
          limit,
          offset,
        }),
      ]);
      res.json({ counts, chunks: list.chunks, total: list.total });
    } catch (error) {
      console.error('[Knowledge] list failed:', error);
      res.status(500).json({ error: 'Failed to load knowledge base' });
    }
  });

  // Per-chunk retrieval usage from rag_rerank_decisions (retrieved / chosen /
  // last used) — fetched once by the UI and joined client-side.
  router.get('/admin/api/knowledge/usage', canRead, async (_req, res) => {
    try {
      const usage = await getChunkRetrievalStats();
      res.json({ usage });
    } catch (error) {
      console.error('[Knowledge] usage failed:', error);
      res.status(500).json({ error: 'Failed to load usage stats' });
    }
  });

  // RAG rerank eval hook (ai-therapist-88): recent listwise rerank decisions +
  // movement / fallback-rate / p95-latency stats, so we can judge whether
  // reranking earns its latency before building a fuller eval.
  router.get('/admin/api/knowledge/rerank-decisions', canRead, async (req, res) => {
    const toolName = typeof req.query.tool === 'string' && req.query.tool ? req.query.tool : null;
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim() ? req.query.sessionId.trim() : null;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    try {
      const [stats, decisions] = await Promise.all([
        getRerankStats({ toolName }),
        listRerankDecisions({ toolName, sessionId, limit: Number.isInteger(limit) ? limit : 100 }),
      ]);
      res.json({ stats, decisions });
    } catch (error) {
      console.error('[Knowledge] rerank-decisions failed:', error);
      res.status(500).json({ error: 'Failed to load rerank decisions' });
    }
  });

  // Create a new chunk (researcher-only). Embedded immediately, inserted as
  // active=false — new content always goes through the pending-review queue.
  router.post('/admin/api/knowledge', canWrite, async (req, res) => {
    const parsed = parseChunkBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const fields = parsed.value;
    try {
      const embedding = await embedText(fields.content);
      const chunkId = await createKnowledgeChunk({
        ...fields,
        content_hash: hashContent(fields.content),
        embedding,
      });
      if (chunkId === null) {
        return res.status(409).json({ error: 'Identical content already exists in the knowledge base' });
      }
      res.status(201).json({ success: true, chunk_id: chunkId, active: false });
    } catch (error) {
      console.error('[Knowledge] create failed:', error);
      res.status(500).json({ error: 'Failed to create chunk' });
    }
  });

  // Edit a chunk (researcher-only). If the content text changed we recompute
  // the hash, re-embed, and reset active=false — edited clinical content must
  // re-clear review before it can be retrieved again.
  router.put('/admin/api/knowledge/:id', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const parsed = parseChunkBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const fields = parsed.value;
    try {
      const existing = await getKnowledgeChunkById(id);
      if (!existing) return res.status(404).json({ error: 'chunk not found' });

      const contentChanged = existing.content !== fields.content;
      const contentChange = contentChanged
        ? { content_hash: hashContent(fields.content), embedding: await embedText(fields.content) }
        : null;
      const ok = await updateKnowledgeChunk(id, { ...fields, contentChange });
      if (!ok) return res.status(404).json({ error: 'chunk not found' });
      res.json({ success: true, id, content_changed: contentChanged, active: contentChanged ? false : undefined });
    } catch (error) {
      // UNIQUE(content_hash): the edited text duplicates another chunk.
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Another chunk already has identical content' });
      }
      console.error('[Knowledge] update failed:', error);
      res.status(500).json({ error: 'Failed to update chunk' });
    }
  });

  // Test-retrieval playground (researcher-only): run the real embed -> vector
  // search -> rerank pipeline for an arbitrary query WITHOUT logging a
  // rag_rerank_decisions row (test calls aren't session traffic). Can include
  // inactive chunks to preview how pending content would rank once approved.
  router.post('/admin/api/knowledge/test-retrieval', canWrite, async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'query is required' });
    const kind = typeof req.body?.kind === 'string' ? req.body.kind.trim() : '';
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
    }
    const topic = optionalText(req.body?.topic);
    const modality = optionalText(req.body?.modality, 100);
    const includeInactive = req.body?.includeInactive === true;
    // Mirror the live tools: widen to 8 candidates, rerank down to 3.
    try {
      const embedding = await embedText(query);
      const candidates = await searchKnowledgeChunks(embedding, { kind, topic, modality }, 8, { includeInactive });
      const rerank = await rerankChunks(query, candidates, 3, {
        sessionId: null,
        toolName: 'admin_test_retrieval',
        skipDecisionLog: true,
      });
      res.json({
        candidates: candidates.map((c, i) => ({
          chunk_id: c.chunk_id,
          title: c.title,
          topic: c.topic,
          kind: c.kind,
          modality: c.modality,
          active: c.active ?? true,
          vec_rank: i,
          similarity: c.similarity,
          content_preview: c.content.slice(0, 300),
        })),
        chosen: rerank.chunks.map(c => c.chunk_id),
        used_fallback: rerank.usedFallback,
        latency_ms: rerank.latencyMs,
      });
    } catch (error) {
      console.error('[Knowledge] test-retrieval failed:', error);
      res.status(500).json({ error: 'Test retrieval failed' });
    }
  });

  // Approve / unapprove a single chunk. Approval now requires (and records) an
  // approver identity + optional note (ai-therapist-88 audit trail).
  router.post('/admin/api/knowledge/:id/active', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const active = req.body?.active === true;
    const actor = req.session.username ?? 'unknown-admin';
    const note = normalizeNote(req.body?.note);
    if (active && !req.session.username) {
      return res.status(400).json({ error: 'approval requires an identified admin' });
    }
    try {
      const ok = await setKnowledgeChunkActive(id, active, actor, note);
      if (!ok) return res.status(404).json({ error: 'chunk not found' });
      res.json({ success: true, id, active });
    } catch (error) {
      console.error('[Knowledge] set active failed:', error);
      res.status(500).json({ error: 'Failed to update chunk' });
    }
  });

  // Bulk approve all pending, optionally scoped to a kind and/or topic.
  router.post('/admin/api/knowledge/approve', canWrite, async (req, res) => {
    const kind = typeof req.body?.kind === 'string' && req.body.kind ? req.body.kind : null;
    const topic = typeof req.body?.topic === 'string' && req.body.topic ? req.body.topic : null;
    const actor = req.session.username ?? 'unknown-admin';
    const note = normalizeNote(req.body?.note);
    if (!req.session.username) {
      return res.status(400).json({ error: 'approval requires an identified admin' });
    }
    try {
      const approved = await approveKnowledgeChunks({ kind, topic }, actor, note);
      res.json({ success: true, approved });
    } catch (error) {
      console.error('[Knowledge] bulk approve failed:', error);
      res.status(500).json({ error: 'Failed to approve chunks' });
    }
  });

  // Permanently delete a chunk.
  router.delete('/admin/api/knowledge/:id', canWrite, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = await deleteKnowledgeChunk(id);
      if (!ok) return res.status(404).json({ error: 'chunk not found' });
      res.json({ success: true });
    } catch (error) {
      console.error('[Knowledge] delete failed:', error);
      res.status(500).json({ error: 'Failed to delete chunk' });
    }
  });

  return router;
}
