// Magic-link demo entry: token gating (wrong/missing token falls through like
// an unknown route) and session hygiene — provisioning the demo login must
// rotate the session id and shed any fields left by a previous real login
// (a stale orgId would scope the demo account's org-gated lookups to a real org).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  createDemoUser: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import magicLinkRoutes from './magicLink.routes.js';

const TOKEN = 'test-demo-token';

function makeApp() {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.post('/test/seed', (req, res) => {
    req.session.userId = 1;
    req.session.userRole = 'researcher';
    req.session.orgId = 42;
    res.json({ ok: true });
  });
  app.get('/test/session', (req, res) => {
    res.json({
      userId: req.session.userId ?? null,
      userRole: req.session.userRole ?? null,
      orgId: req.session.orgId ?? null,
    });
  });
  app.use(magicLinkRoutes());
  // next() fall-through target, standing in for the SSR handler.
  app.use((_req, res) => res.status(404).send('not found'));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEMO_MAGIC_TOKEN = TOKEN;
  dbMocks.createDemoUser.mockResolvedValue({ userid: 900, username: 'demo_x' });
});

afterEach(() => {
  delete process.env.DEMO_MAGIC_TOKEN;
});

describe('GET /demo/:token', () => {
  it('falls through like an unknown route on a wrong token', async () => {
    const res = await request(makeApp()).get('/demo/wrong-token');
    expect(res.status).toBe(404);
    expect(dbMocks.createDemoUser).not.toHaveBeenCalled();
  });

  it('falls through when the feature is disabled (no env token)', async () => {
    delete process.env.DEMO_MAGIC_TOKEN;
    const res = await request(makeApp()).get(`/demo/${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('provisions a demo account and redirects on the right token', async () => {
    const agent = request.agent(makeApp());
    const res = await agent.get(`/demo/${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/demo');
    const state = await agent.get('/test/session');
    expect(state.body).toEqual({ userId: 900, userRole: 'demo', orgId: null });
  });

  it('rotates the session and drops a previous login\'s orgId', async () => {
    const agent = request.agent(makeApp());
    await agent.post('/test/seed');
    const res = await agent.get(`/demo/${TOKEN}`);
    expect(res.status).toBe(302);
    const state = await agent.get('/test/session');
    expect(state.body.userRole).toBe('demo');
    expect(state.body.orgId).toBeNull();
  });
});

describe('production guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.DEMO_SITE;
    delete process.env.ALLOW_DEMO;
  });

  it('refuses the magic link in production without DEMO_SITE/ALLOW_DEMO (404, no account)', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(makeApp()).get(`/demo/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(dbMocks.createDemoUser).not.toHaveBeenCalled();
  });

  it('stays enabled in production on the demo site (DEMO_SITE=true)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_SITE = 'true';
    const res = await request(makeApp()).get(`/demo/${TOKEN}`);
    expect(res.status).toBe(302);
    expect(dbMocks.createDemoUser).toHaveBeenCalled();
  });

  it('honors the explicit ALLOW_DEMO=true override in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_DEMO = 'true';
    const res = await request(makeApp()).get(`/demo/${TOKEN}`);
    expect(res.status).toBe(302);
  });
});
