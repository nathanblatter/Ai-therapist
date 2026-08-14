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

import clientEventsRoutes, { capDetail, MAX_DETAIL_BYTES, CLIENT_EVENT_KINDS } from './clientEvents.routes.js';

function makeApp(sessionUserId: number | null = null) {
  const app = express();
  app.use(express.json());
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
      .send({ kind: 'webrtc_failed', sessionId: 'sess-abc', detail: { stage: 'start' } });
    expect(res.status).toBe(204);
    expect(insertClientEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webrtc_failed',
        sessionId: 'sess-abc',
        userId: 7,
        detail: { stage: 'start' },
      })
    );
  });

  it('drops an over-long sessionId rather than storing it', async () => {
    await request(makeApp()).post('/api/client-events').send({ kind: 'js_error', sessionId: 'x'.repeat(200) });
    expect(insertClientEventMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it('truncates an oversized detail payload', async () => {
    await request(makeApp())
      .post('/api/client-events')
      .send({ kind: 'js_error', detail: { message: 'y'.repeat(5000) } });
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
