// Route coverage for the public client error beacon (pass-3 telemetry):
// kind allowlist, detail size cap, session/user attribution, insert-failure
// swallowing, and the per-IP rate limit backstop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { insertClientEventMock } = vi.hoisted(() => ({ insertClientEventMock: vi.fn() }));

vi.mock('../../db/index.js', () => ({
  insertClientEvent: insertClientEventMock,
}));

import clientEventsRoutes, { capDetail, cleanSessionId, MAX_DETAIL_BYTES, CLIENT_EVENT_KINDS } from './clientEvents.routes.js';

function makeApp(sessionUserId: number | null = null) {
  const app = express();
  // No app-level express.json() on purpose: the route mounts its own parser
  // with a 4kb limit (index.ts skips the global parser for this path too).
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session =
      sessionUserId ? { userId: sessionUserId } : {};
    next();
  });
  app.use(clientEventsRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertClientEventMock.mockResolvedValue(undefined);
});

describe('capDetail', () => {
  it('passes small objects through untouched', () => {
    expect(capDetail({ a: 1 })).toEqual({ a: 1 });
  });

  it('returns null for non-objects and arrays', () => {
    expect(capDetail(null)).toBeNull();
    expect(capDetail(undefined)).toBeNull();
    expect(capDetail('a string')).toBeNull();
    expect(capDetail([1, 2, 3])).toBeNull();
  });

  it('replaces oversized payloads with a truncation marker', () => {
    const big = { blob: 'x'.repeat(MAX_DETAIL_BYTES + 100) };
    const capped = capDetail(big);
    expect(capped).toMatchObject({ truncated: true });
    expect(JSON.stringify(capped).length).toBeLessThan(200);
  });
});

describe('POST /api/client-events', () => {
  it('accepts every allowlisted kind with 204', async () => {
    const app = makeApp();
    for (const kind of CLIENT_EVENT_KINDS) {
      const res = await request(app).post('/api/client-events').send({ kind });
      expect(res.status).toBe(204);
    }
    expect(insertClientEventMock).toHaveBeenCalledTimes(CLIENT_EVENT_KINDS.length);
  });

  it('rejects unknown kinds with 400 and never touches the db', async () => {
    const res = await request(makeApp()).post('/api/client-events').send({ kind: 'made_up_kind' });
    expect(res.status).toBe(400);
    expect(insertClientEventMock).not.toHaveBeenCalled();
  });

  it('rejects a missing kind with 400', async () => {
    const res = await request(makeApp()).post('/api/client-events').send({ detail: { a: 1 } });
    expect(res.status).toBe(400);
  });

  it('stores sessionId, session userId, and capped detail', async () => {
    const res = await request(makeApp(7))
      .post('/api/client-events')
      .send({ kind: 'webrtc_failed', sessionId: 'sess_abc123', detail: { stage: 'start' } });
    expect(res.status).toBe(204);
    expect(insertClientEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webrtc_failed',
        sessionId: 'sess_abc123',
        userId: 7,
        detail: { stage: 'start' },
      })
    );
  });

  it('drops an over-long sessionId rather than storing it', async () => {
    await request(makeApp()).post('/api/client-events').send({ kind: 'js_error', sessionId: 'sess_' + 'x'.repeat(200) });
    expect(insertClientEventMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it('nulls sessionIds that do not match the app id shapes', async () => {
    for (const bad of ['sess-abc', 'DROP TABLE;--', 'random', 'sess_', 'sess_abc def']) {
      insertClientEventMock.mockClear();
      await request(makeApp()).post('/api/client-events').send({ kind: 'js_error', sessionId: bad });
      expect(insertClientEventMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
    }
  });

  it('accepts each real session id prefix (sess_/chat_/redteam_)', () => {
    expect(cleanSessionId('sess_CAZFtG3xyz')).toBe('sess_CAZFtG3xyz');
    expect(cleanSessionId('chat_1723600000_ab12cd')).toBe('chat_1723600000_ab12cd');
    expect(cleanSessionId('redteam_rt_1723600000_x1y2z3')).toBe('redteam_rt_1723600000_x1y2z3');
    expect(cleanSessionId(42)).toBeNull();
    expect(cleanSessionId(null)).toBeNull();
  });

  it('rejects an oversized body pre-parse with 413 (route-local 4kb json limit)', async () => {
    const res = await request(makeApp())
      .post('/api/client-events')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ kind: 'js_error', detail: { blob: 'z'.repeat(10_000) } }));
    expect(res.status).toBe(413);
    expect(insertClientEventMock).not.toHaveBeenCalled();
  });

  it('truncates an oversized detail payload (over the 2KB detail cap, under the 4kb body limit)', async () => {
    await request(makeApp())
      .post('/api/client-events')
      .send({ kind: 'js_error', detail: { message: 'y'.repeat(3000) } });
    expect(insertClientEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ truncated: true }) })
    );
  });

  it('still returns 204 when the insert fails (beacons are fire-and-forget)', async () => {
    insertClientEventMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp()).post('/api/client-events').send({ kind: 'js_error' });
    expect(res.status).toBe(204);
  });

  it('rate limits after 30 requests per IP per minute', async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await request(app).post('/api/client-events').send({ kind: 'js_error' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    expect(insertClientEventMock).toHaveBeenCalledTimes(30);
  });
});
