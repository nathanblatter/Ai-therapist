// Public bug-report forwarders: per-IP rate limiting (unauthenticated write
// endpoints must not be able to flood flightdeck) and input caps on the
// forwarded url/meta fields.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import bugReportRoutes from './bugReport.routes.js';

const fetchMock = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(bugReportRoutes());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FLIGHTDECK_INGEST_KEY = 'test-key';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: '11111111-2222-3333-4444-555555555555' }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FLIGHTDECK_INGEST_KEY;
});

function forwardedBody(callIndex = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[callIndex][1] as { body: string }).body);
}

describe('POST /api/bug-report', () => {
  it('forwards a valid report', async () => {
    const res = await request(makeApp()).post('/api/bug-report').send({ message: 'it broke', severity: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(forwardedBody()).toMatchObject({ site: 'ai-therapist', message: 'it broke', severity: 'high' });
  });

  it('caps an oversized url and non-string urls', async () => {
    await request(makeApp()).post('/api/bug-report').send({ message: 'm', url: 'https://x/' + 'a'.repeat(5000) });
    expect((forwardedBody().url as string).length).toBe(2048);

    fetchMock.mockClear();
    await request(makeApp()).post('/api/bug-report').send({ message: 'm', url: { evil: true } });
    expect(forwardedBody().url).toBe('');
  });

  it('replaces an oversized meta blob with a size marker', async () => {
    await request(makeApp()).post('/api/bug-report').send({ message: 'm', meta: { blob: 'x'.repeat(20_000) } });
    expect(forwardedBody().meta).toMatchObject({ truncated: true });

    fetchMock.mockClear();
    await request(makeApp()).post('/api/bug-report').send({ message: 'm', meta: ['not', 'an', 'object'] });
    expect(forwardedBody().meta).toEqual({});
  });

  it('rate limits after 10 reports per IP', async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/api/bug-report').send({ message: 'spam ' + i });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});

describe('POST /api/bug-report/:id/screenshots', () => {
  it('rate limits the unauthenticated upload endpoint too', async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      // Invalid content-type -> rejected early; still counts for the limiter.
      const res = await request(app)
        .post('/api/bug-report/11111111-2222-3333-4444-555555555555/screenshots')
        .send({});
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
