// Flightdeck findings proxy: role gate, config gate, trimming/sorting, and
// upstream-failure mapping. The flightdeck HTTP API is mocked via fetch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import flightdeckRoutes from './flightdeck.routes.js';

function appAs(role: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    // @ts-expect-error minimal session stand-in
    req.session = role ? { userId: 7, userRole: role } : {};
    next();
  });
  app.use(flightdeckRoutes());
  return app;
}

const ITEM = {
  ref: 'ai-therapist-1',
  type: 'bug',
  title: 'Mic meter frozen',
  body: 'b'.repeat(2000),
  status: 'todo',
  priority: 'high',
  source: 'bug_reporter',
  tags: ['stress-test'],
  created_at: '2026-09-09T00:00:00Z',
  updated_at: '2026-09-09T01:00:00Z',
};

beforeEach(() => {
  process.env.FLIGHTDECK_READ_KEY = 'fd_test_read';
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  delete process.env.FLIGHTDECK_READ_KEY;
  vi.unstubAllGlobals();
});

describe('GET /admin/api/flightdeck/findings', () => {
  it('rejects non-staff roles and anonymous', async () => {
    expect((await request(appAs('participant')).get('/admin/api/flightdeck/findings')).status).toBe(403);
    expect((await request(appAs('caseworker')).get('/admin/api/flightdeck/findings')).status).toBe(403);
    expect((await request(appAs(null)).get('/admin/api/flightdeck/findings')).status).toBe(401);
  });

  it('503s when the read key is not configured', async () => {
    delete process.env.FLIGHTDECK_READ_KEY;
    const res = await request(appAs('researcher')).get('/admin/api/flightdeck/findings');
    expect(res.status).toBe(503);
  });

  it('proxies, trims bodies, and sorts open items first', async () => {
    const closed = { ...ITEM, ref: 'ai-therapist-2', status: 'done', updated_at: '2026-09-09T05:00:00Z' };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [closed, ITEM],
    } as unknown as Response);

    const res = await request(appAs('therapist')).get('/admin/api/flightdeck/findings');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { ref: string }) => i.ref)).toEqual(['ai-therapist-1', 'ai-therapist-2']);
    expect(res.body.items[0].open).toBe(true);
    expect(res.body.items[0].body.length).toBe(1500);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call[0])).toContain('/api/items?project=ai-therapist');
    expect((call[1]?.headers as Record<string, string>)['X-API-Key']).toBe('fd_test_read');
  });

  it('maps upstream failures to 502', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const res = await request(appAs('researcher')).get('/admin/api/flightdeck/findings');
    expect(res.status).toBe(502);
  });
});
