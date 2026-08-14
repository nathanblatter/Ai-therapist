// Route tests for the knowledge-base admin revamp (ai-therapist-116):
// create/edit go through embedding + pending review, test-retrieval never
// logs a rerank decision, and researcher-only guards hold on the new writes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

const dbMocks = vi.hoisted(() => ({
  listKnowledgeChunks: vi.fn().mockResolvedValue({ chunks: [], total: 0 }),
  createKnowledgeChunk: vi.fn().mockResolvedValue(42),
  updateKnowledgeChunk: vi.fn().mockResolvedValue(true),
  getKnowledgeChunkById: vi.fn().mockResolvedValue({ chunk_id: 7, content: 'old content' }),
  setKnowledgeChunkActive: vi.fn().mockResolvedValue(true),
  deleteKnowledgeChunk: vi.fn().mockResolvedValue(true),
  approveKnowledgeChunks: vi.fn().mockResolvedValue(3),
  getKnowledgeStatusCounts: vi.fn().mockResolvedValue([]),
  searchKnowledgeChunks: vi.fn().mockResolvedValue([]),
  getChunkRetrievalStats: vi.fn().mockResolvedValue([]),
  listRerankDecisions: vi.fn().mockResolvedValue([]),
  getRerankStats: vi.fn().mockResolvedValue({ total: 0, fallback_rate: 0, movement_rate: 0, p95_latency_ms: null }),
}));
vi.mock('../../db/index.js', () => dbMocks);

const serviceMocks = vi.hoisted(() => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  rerankChunks: vi.fn().mockResolvedValue({ chunks: [], usedFallback: true, latencyMs: 12 }),
}));
vi.mock('../../services/embeddings.service.js', () => ({ embedText: serviceMocks.embedText }));
vi.mock('../../services/rerank.service.js', () => ({ rerankChunks: serviceMocks.rerankChunks }));

import knowledgeRoutes from './knowledge.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = role
      ? ({ userId: 1, userRole: role, username: 'tester' } as unknown as typeof req.session)
      : ({} as unknown as typeof req.session);
    next();
  });
  app.use(knowledgeRoutes());
  return app;
}

const VALID_BODY = {
  kind: 'psychoeducation',
  topic: 'anxiety',
  title: 'Grounding basics',
  content: 'Some new psychoeducation text.',
  source: 'clinician-authored',
};

beforeEach(() => {
  Object.values(dbMocks).forEach(m => m.mockClear());
  Object.values(serviceMocks).forEach(m => m.mockClear());
  dbMocks.getKnowledgeChunkById.mockResolvedValue({ chunk_id: 7, content: 'old content' });
});

describe('POST /admin/api/knowledge (create)', () => {
  it('is researcher-only', async () => {
    await request(appAs('therapist')).post('/admin/api/knowledge').send(VALID_BODY).expect(403);
    await request(appAs(null)).post('/admin/api/knowledge').send(VALID_BODY).expect(401);
    expect(dbMocks.createKnowledgeChunk).not.toHaveBeenCalled();
  });

  it('rejects an invalid kind and missing content/source', async () => {
    const app = appAs('researcher');
    await request(app).post('/admin/api/knowledge').send({ ...VALID_BODY, kind: 'blog-post' }).expect(400);
    await request(app).post('/admin/api/knowledge').send({ ...VALID_BODY, content: '  ' }).expect(400);
    await request(app).post('/admin/api/knowledge').send({ ...VALID_BODY, source: '' }).expect(400);
    expect(serviceMocks.embedText).not.toHaveBeenCalled();
  });

  it('embeds the content and inserts as pending', async () => {
    const res = await request(appAs('researcher')).post('/admin/api/knowledge').send(VALID_BODY).expect(201);
    expect(res.body).toEqual({ success: true, chunk_id: 42, active: false });
    expect(serviceMocks.embedText).toHaveBeenCalledWith(VALID_BODY.content);
    const input = dbMocks.createKnowledgeChunk.mock.calls[0][0];
    expect(input.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(input.content_hash).toMatch(/^[0-9a-f]{32}$/); // md5, matches ingest script
  });

  it('returns 409 when identical content already exists', async () => {
    dbMocks.createKnowledgeChunk.mockResolvedValueOnce(null);
    await request(appAs('researcher')).post('/admin/api/knowledge').send(VALID_BODY).expect(409);
  });
});

describe('PUT /admin/api/knowledge/:id (edit)', () => {
  it('is researcher-only', async () => {
    await request(appAs('therapist')).put('/admin/api/knowledge/7').send(VALID_BODY).expect(403);
  });

  it('re-embeds and flags content_changed when the content text changed', async () => {
    const res = await request(appAs('researcher')).put('/admin/api/knowledge/7').send(VALID_BODY).expect(200);
    expect(res.body.content_changed).toBe(true);
    expect(res.body.active).toBe(false); // back to pending review
    expect(serviceMocks.embedText).toHaveBeenCalledWith(VALID_BODY.content);
    const input = dbMocks.updateKnowledgeChunk.mock.calls[0][1];
    expect(input.contentChange).toEqual({ content_hash: expect.any(String), embedding: [0.1, 0.2, 0.3] });
  });

  it('skips re-embedding on a metadata-only edit', async () => {
    dbMocks.getKnowledgeChunkById.mockResolvedValueOnce({ chunk_id: 7, content: VALID_BODY.content });
    const res = await request(appAs('researcher')).put('/admin/api/knowledge/7').send(VALID_BODY).expect(200);
    expect(res.body.content_changed).toBe(false);
    expect(serviceMocks.embedText).not.toHaveBeenCalled();
    expect(dbMocks.updateKnowledgeChunk.mock.calls[0][1].contentChange).toBeNull();
  });

  it('404s on an unknown chunk', async () => {
    dbMocks.getKnowledgeChunkById.mockResolvedValueOnce(null);
    await request(appAs('researcher')).put('/admin/api/knowledge/404').send(VALID_BODY).expect(404);
  });
});

describe('POST /admin/api/knowledge/test-retrieval (playground)', () => {
  it('is researcher-only', async () => {
    await request(appAs('therapist'))
      .post('/admin/api/knowledge/test-retrieval')
      .send({ query: 'q', kind: 'psychoeducation' })
      .expect(403);
  });

  it('runs embed -> search -> rerank with decision logging DISABLED', async () => {
    dbMocks.searchKnowledgeChunks.mockResolvedValueOnce([
      { chunk_id: 1, title: 't', topic: null, kind: 'psychoeducation', modality: null, active: true, similarity: 0.9, content: 'abc' },
    ]);
    serviceMocks.rerankChunks.mockResolvedValueOnce({
      chunks: [{ chunk_id: 1 }], usedFallback: false, latencyMs: 200,
    });
    const res = await request(appAs('researcher'))
      .post('/admin/api/knowledge/test-retrieval')
      .send({ query: 'tight chest when anxious', kind: 'psychoeducation', includeInactive: true })
      .expect(200);

    // includeInactive is honored on the vector search
    expect(dbMocks.searchKnowledgeChunks.mock.calls[0][3]).toEqual({ includeInactive: true });
    // rerank is told not to log — test calls aren't session traffic
    expect(serviceMocks.rerankChunks.mock.calls[0][3]).toMatchObject({ skipDecisionLog: true });
    expect(res.body.chosen).toEqual([1]);
    expect(res.body.used_fallback).toBe(false);
    expect(res.body.candidates[0]).toMatchObject({ chunk_id: 1, vec_rank: 0, similarity: 0.9 });
  });

  it('validates query and kind', async () => {
    const app = appAs('researcher');
    await request(app).post('/admin/api/knowledge/test-retrieval').send({ kind: 'psychoeducation' }).expect(400);
    await request(app).post('/admin/api/knowledge/test-retrieval').send({ query: 'q', kind: 'nope' }).expect(400);
  });
});

describe('GET /admin/api/knowledge (list w/ search + paging)', () => {
  it('passes q/limit/offset through and returns total', async () => {
    dbMocks.listKnowledgeChunks.mockResolvedValueOnce({ chunks: [], total: 12 });
    const res = await request(appAs('therapist'))
      .get('/admin/api/knowledge?q=breathing&limit=10&offset=20&kind=worksheet&status=active')
      .expect(200);
    expect(res.body.total).toBe(12);
    expect(dbMocks.listKnowledgeChunks).toHaveBeenCalledWith({
      kind: 'worksheet', active: true, q: 'breathing', limit: 10, offset: 20,
    });
  });
});

describe('GET /admin/api/knowledge/usage', () => {
  it('returns per-chunk retrieval stats', async () => {
    dbMocks.getChunkRetrievalStats.mockResolvedValueOnce([
      { chunk_id: 1, retrieved_count: 5, chosen_count: 2, last_used: null },
    ]);
    const res = await request(appAs('therapist')).get('/admin/api/knowledge/usage').expect(200);
    expect(res.body.usage).toHaveLength(1);
  });
});

describe('GET /admin/api/knowledge/rerank-decisions', () => {
  it('supports the sessionId filter', async () => {
    await request(appAs('researcher'))
      .get('/admin/api/knowledge/rerank-decisions?sessionId=sess-1&tool=retrieve_psychoeducation')
      .expect(200);
    expect(dbMocks.listRerankDecisions).toHaveBeenCalledWith({
      toolName: 'retrieve_psychoeducation', sessionId: 'sess-1', limit: 100,
    });
  });
});
