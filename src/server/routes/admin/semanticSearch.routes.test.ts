// Semantic search endpoint (ai-therapist-177): role gate per role, org
// scoping from the session (never the body), validation, the redacted-only
// payload, the data_access_log rows, and the per-user rate limit. The
// embeddings call is mocked: no paid API traffic from tests.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  logDataAccess: vi.fn(),
  searchRedactedMessages: vi.fn(),
  SEMANTIC_SEARCH_MAX_WINDOW: 200,
}));
vi.mock('../../db/index.js', () => dbMocks);

const embedMocks = vi.hoisted(() => ({ embedText: vi.fn() }));
vi.mock('../../services/embeddings.service.js', () => embedMocks);

const orgMocks = vi.hoisted(() => ({ orgIdFor: vi.fn() }));
vi.mock('../../middleware/org.js', () => orgMocks);

import semanticSearchRoutes, { clearQueryVectorCache, parseSearchBody } from './semanticSearch.routes.js';

function appAs(role: string | null, userId = 7) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: `user${userId}` }
      : {};
    next();
  });
  app.use(semanticSearchRoutes());
  return app;
}

const URL = '/admin/api/semantic-search';
const VEC = [0.1, 0.2, 0.3];

function hit(messageId: string, sessionId: string, ownerUserId: number | null, similarity = 0.6) {
  return {
    messageId,
    sessionId,
    role: 'user',
    text: `[REDACTED] text ${messageId}`,
    createdAt: '2026-11-01 10:00:00+00',
    similarity,
    sessionName: `Session ${sessionId}`,
    sessionStartedAt: '2026-11-01 09:50:00+00',
    ownerUserId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearQueryVectorCache();
  orgMocks.orgIdFor.mockResolvedValue(1);
  embedMocks.embedText.mockResolvedValue(VEC);
  dbMocks.searchRedactedMessages.mockResolvedValue({
    hits: [hit('11', 'sess-a', 42, 0.71), hit('12', 'sess-b', null, 0.65), hit('13', 'sess-a', 42, 0.5)],
    hasMore: false,
  });
});

describe('POST /admin/api/semantic-search: RBAC', () => {
  it('allows researchers', async () => {
    const res = await request(appAs('researcher')).post(URL).send({ query: 'sleep problems' });
    expect(res.status).toBe(200);
  });

  it.each(['therapist', 'caseworker', 'demo', 'participant'])('rejects %s with 403 before any work', async (role) => {
    const res = await request(appAs(role)).post(URL).send({ query: 'sleep problems' });
    expect(res.status).toBe(403);
    expect(embedMocks.embedText).not.toHaveBeenCalled();
    expect(dbMocks.searchRedactedMessages).not.toHaveBeenCalled();
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });

  it('rejects anonymous callers with 401', async () => {
    const res = await request(appAs(null)).post(URL).send({ query: 'sleep problems' });
    expect(res.status).toBe(401);
    expect(embedMocks.embedText).not.toHaveBeenCalled();
  });

  it("scopes to the caller's organization from the session, ignoring any orgId in the body", async () => {
    orgMocks.orgIdFor.mockResolvedValue(3);
    await request(appAs('researcher')).post(URL).send({ query: 'sleep problems', orgId: 1 });
    expect(dbMocks.searchRedactedMessages).toHaveBeenCalledWith(expect.objectContaining({ orgId: 3 }));
  });

  it('fails closed (500, no search) when the org lookup throws', async () => {
    orgMocks.orgIdFor.mockRejectedValue(new Error('db down'));
    const res = await request(appAs('researcher')).post(URL).send({ query: 'sleep problems' });
    expect(res.status).toBe(500);
    expect(dbMocks.searchRedactedMessages).not.toHaveBeenCalled();
  });
});

describe('POST /admin/api/semantic-search: search + payload', () => {
  it('embeds the trimmed query once and passes filters through', async () => {
    const res = await request(appAs('researcher')).post(URL).send({
      query: '  sleep problems  ',
      sessionId: 'sess-a',
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
      minSimilarity: 0.4,
      limit: 10,
      offset: 10,
    });
    expect(res.status).toBe(200);
    expect(embedMocks.embedText).toHaveBeenCalledTimes(1);
    expect(embedMocks.embedText).toHaveBeenCalledWith('sleep problems');
    expect(dbMocks.searchRedactedMessages).toHaveBeenCalledWith({
      embedding: VEC,
      orgId: 1,
      sessionId: 'sess-a',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      minSimilarity: 0.4,
      limit: 10,
      offset: 10,
    });
    expect(res.body.nextOffset).toBe(13);
  });

  it('returns the redacted text and never the owner id', async () => {
    const res = await request(appAs('researcher')).post(URL).send({ query: 'sleep problems' });
    expect(res.body.hits).toHaveLength(3);
    expect(res.body.hits[0]).toEqual({
      messageId: '11',
      sessionId: 'sess-a',
      sessionName: 'Session sess-a',
      sessionStartedAt: '2026-11-01 09:50:00+00',
      role: 'user',
      text: '[REDACTED] text 11',
      createdAt: '2026-11-01 10:00:00+00',
      similarity: 0.71,
    });
    expect(JSON.stringify(res.body)).not.toContain('ownerUserId');
  });

  it('re-uses the query vector for paging (one embeddings call per distinct query per user)', async () => {
    const app = appAs('researcher');
    await request(app).post(URL).send({ query: 'sleep problems' });
    await request(app).post(URL).send({ query: 'sleep problems', offset: 25 });
    expect(embedMocks.embedText).toHaveBeenCalledTimes(1);
    await request(appAs('researcher', 8)).post(URL).send({ query: 'sleep problems' });
    expect(embedMocks.embedText).toHaveBeenCalledTimes(2);
  });

  it('502s without searching or auditing when the embeddings call fails', async () => {
    embedMocks.embedText.mockRejectedValue(new Error('Embeddings API error: 500'));
    const res = await request(appAs('researcher')).post(URL).send({ query: 'sleep problems' });
    expect(res.status).toBe(502);
    expect(dbMocks.searchRedactedMessages).not.toHaveBeenCalled();
    expect(dbMocks.logDataAccess).not.toHaveBeenCalled();
  });
});

describe('POST /admin/api/semantic-search: data_access_log', () => {
  it('writes one semantic_search row per returned session with the query and message ids', async () => {
    await request(appAs('researcher')).post(URL).send({ query: 'sleep problems' });
    expect(dbMocks.logDataAccess).toHaveBeenCalledTimes(2);
    const filters = { sessionId: null, from: null, to: null, minSimilarity: 0.3, limit: 25, offset: 0 };
    expect(dbMocks.logDataAccess).toHaveBeenCalledWith({
      accessedBy: 7,
      role: 'researcher',
      action: 'semantic_search',
      sessionId: 'sess-a',
      userId: 42,
      detail: { query: 'sleep problems', contentColumn: 'content_redacted', messageIds: ['11', '13'], filters },
    });
    expect(dbMocks.logDataAccess).toHaveBeenCalledWith({
      accessedBy: 7,
      role: 'researcher',
      action: 'semantic_search',
      sessionId: 'sess-b',
      userId: null,
      detail: { query: 'sleep problems', contentColumn: 'content_redacted', messageIds: ['12'], filters },
    });
  });

  it('still records the query in one session-less row when nothing matched', async () => {
    dbMocks.searchRedactedMessages.mockResolvedValue({ hits: [], hasMore: false });
    await request(appAs('researcher')).post(URL).send({ query: 'sleep problems' });
    expect(dbMocks.logDataAccess).toHaveBeenCalledTimes(1);
    const row = dbMocks.logDataAccess.mock.calls[0][0];
    expect(row).toMatchObject({ action: 'semantic_search', accessedBy: 7, role: 'researcher' });
    expect(row.sessionId).toBeUndefined();
    expect(row.detail).toMatchObject({ query: 'sleep problems', messageIds: [] });
  });
});

describe('POST /admin/api/semantic-search: rate limit', () => {
  it('limits each researcher to 30 searches per 10 minutes', async () => {
    const app = appAs('researcher');
    for (let i = 0; i < 30; i++) {
      expect(
        (
          await request(app)
            .post(URL)
            .send({ query: `query number ${i}` })
        ).status,
      ).toBe(200);
    }
    const res = await request(app).post(URL).send({ query: 'one too many' });
    expect(res.status).toBe(429);
    expect(embedMocks.embedText).toHaveBeenCalledTimes(30);
  });
});

describe('parseSearchBody', () => {
  it('applies defaults', () => {
    expect(parseSearchBody({ query: 'sleep' })).toEqual({
      query: 'sleep',
      sessionId: null,
      from: null,
      to: null,
      minSimilarity: 0.3,
      limit: 25,
      offset: 0,
    });
  });

  it.each([
    [{}, /query/],
    [{ query: 'hi' }, /query/],
    [{ query: 'x'.repeat(501) }, /query/],
    [{ query: 'sleep', sessionId: "x' OR 1=1" }, /sessionId/],
    [{ query: 'sleep', from: 'yesterday' }, /from\/to/],
    [{ query: 'sleep', from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }, /before/],
    [{ query: 'sleep', minSimilarity: 1.5 }, /minSimilarity/],
    [{ query: 'sleep', limit: 0 }, /limit/],
    [{ query: 'sleep', limit: 51 }, /limit/],
    [{ query: 'sleep', offset: -1 }, /offset/],
    [{ query: 'sleep', limit: 50, offset: 151 }, /capped/],
  ])('rejects %j', (body, message) => {
    const out = parseSearchBody(body);
    expect(typeof out).toBe('string');
    expect(out).toMatch(message);
  });

  it('400s through the route without calling the embeddings API', async () => {
    const res = await request(appAs('researcher')).post(URL).send({ query: 'hi' });
    expect(res.status).toBe(400);
    expect(embedMocks.embedText).not.toHaveBeenCalled();
  });
});
