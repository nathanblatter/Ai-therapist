// Login session hygiene: logging in must rotate the session id (fixation)
// and must not let fields stamped for a PREVIOUS account leak into the new
// login — a stale session orgId short-circuits orgIdFor and scopes the new
// user's org-gated queries to the wrong organization. Browser-scoped state
// (consent acceptance, anonymous session ownership) must survive the rotation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  verifyCredentials: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import authRoutes from './auth.routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  // Seed the session as if a previous account had logged in on this browser.
  app.post('/test/seed', (req, res) => {
    req.session.userId = 1;
    req.session.userRole = 'caseworker';
    req.session.orgId = 99;
    req.session.isSandbox = true;
    req.session.consentAccepted = true;
    req.session.consentVersion = 'v-test';
    req.session.ownedSessions = ['chat_123_abc'];
    res.json({ ok: true });
  });
  app.get('/test/session', (req, res) => {
    res.json({
      userId: req.session.userId ?? null,
      userRole: req.session.userRole ?? null,
      orgId: req.session.orgId ?? null,
      isSandbox: req.session.isSandbox ?? null,
      consentAccepted: req.session.consentAccepted ?? null,
      consentVersion: req.session.consentVersion ?? null,
      ownedSessions: req.session.ownedSessions ?? null,
    });
  });
  app.use(authRoutes());
  return app;
}

function sidOf(setCookie: unknown): string {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = list.find((c): c is string => typeof c === 'string' && c.startsWith('connect.sid='));
  if (!cookie) throw new Error('no session cookie issued');
  return cookie.split(';')[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/auth/login session handling', () => {
  it('rotates the session id and drops the previous account\'s orgId/isSandbox', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    const seeded = await agent.post('/test/seed');
    const oldSid = sidOf(seeded.headers['set-cookie']);

    // New user WITHOUT an organization_id: with a stale orgId=99 left on the
    // session, orgIdFor would silently scope them to org 99.
    dbMocks.verifyCredentials.mockResolvedValue({
      userid: 2, username: 'part1', role: 'participant', mfa_enabled: false,
    });
    const login = await agent.post('/api/auth/login').send({ username: 'part1', password: 'pw' });
    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);

    const newSid = sidOf(login.headers['set-cookie']);
    expect(newSid).not.toBe(oldSid);

    const state = await agent.get('/test/session');
    expect(state.body.userId).toBe(2);
    expect(state.body.userRole).toBe('participant');
    expect(state.body.orgId).toBeNull();
    expect(state.body.isSandbox).toBe(false);
  });

  it('carries consent acceptance and owned anonymous sessions across the rotation', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/test/seed');

    dbMocks.verifyCredentials.mockResolvedValue({
      userid: 3, username: 'part2', role: 'participant', mfa_enabled: false,
    });
    await agent.post('/api/auth/login').send({ username: 'part2', password: 'pw' });

    const state = await agent.get('/test/session');
    expect(state.body.consentAccepted).toBe(true);
    expect(state.body.consentVersion).toBe('v-test');
    expect(state.body.ownedSessions).toEqual(['chat_123_abc']);
  });

  it('stamps orgId for users that have one', async () => {
    const app = makeApp();
    const agent = request.agent(app);

    dbMocks.verifyCredentials.mockResolvedValue({
      userid: 4, username: 'cw', role: 'caseworker', mfa_enabled: false, organization_id: 7,
    });
    await agent.post('/api/auth/login').send({ username: 'cw', password: 'pw' });

    const state = await agent.get('/test/session');
    expect(state.body.orgId).toBe(7);
  });
});

describe('POST /api/auth/register validation', () => {
  function makeRegisterApp() {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    // Seed a researcher session (register is researcher-only).
    app.post('/test/seed-researcher', (req, res) => {
      req.session.userId = 1;
      req.session.userRole = 'researcher';
      res.json({ ok: true });
    });
    app.use(authRoutes());
    return app;
  }

  it('rejects passwords shorter than 12 characters with a 400', async () => {
    const agent = request.agent(makeRegisterApp());
    await agent.post('/test/seed-researcher');
    const res = await agent
      .post('/api/auth/register')
      .send({ username: 'newuser', password: 'elevenchars', role: 'participant' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 12 characters');
    expect(dbMocks.createUser).not.toHaveBeenCalled();
  });

  it('accepts a 12-character password', async () => {
    dbMocks.createUser.mockResolvedValue({ userid: 5, username: 'newuser', role: 'participant' });
    const agent = request.agent(makeRegisterApp());
    await agent.post('/test/seed-researcher');
    const res = await agent
      .post('/api/auth/register')
      .send({ username: 'newuser', password: 'twelvechars!', role: 'participant' });
    expect(res.status).toBe(200);
    expect(dbMocks.createUser).toHaveBeenCalledWith('newuser', 'twelvechars!', 'participant');
  });

  it('maps the research-org caseworker rejection to a 400 with the db error message', async () => {
    const err = new Error('Caseworker accounts cannot be created in a research organization');
    err.name = 'ResearchOrgCaseworkerError';
    dbMocks.createUser.mockRejectedValue(err);
    const agent = request.agent(makeRegisterApp());
    await agent.post('/test/seed-researcher');
    const res = await agent
      .post('/api/auth/register')
      .send({ username: 'cw1', password: 'twelvechars!', role: 'caseworker' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Caseworker accounts cannot be created in a research organization');
  });
});
