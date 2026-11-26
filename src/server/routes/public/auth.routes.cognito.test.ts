// With Cognito configured (ai-therapist-387) the legacy password login must
// refuse before it looks at the local hash: the password of record lives in
// the study's user pool, and a stale local copy must never sign anyone in.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_TestPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'client123');
vi.stubEnv('COGNITO_DOMAIN', 'https://study-test.auth.us-west-1.amazoncognito.com');
vi.stubEnv('APP_URL', 'https://app.test');

const dbMocks = vi.hoisted(() => ({
  verifyCredentials: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const { default: authRoutes } = await import('./auth.routes.js');

describe('POST /api/auth/logout with Cognito configured', () => {
  it('ends the app session and names the hosted sign-out page', async () => {
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.post('/test/seed', (req, res) => {
      req.session.userId = 1;
      res.json({ ok: true });
    });
    app.get('/test/session', (req, res) => res.json({ userId: req.session.userId ?? null }));
    app.use(authRoutes());
    const agent = request.agent(app);
    await agent.post('/test/seed');
    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const url = new URL(res.body.redirect);
    expect(url.origin + url.pathname).toBe('https://study-test.auth.us-west-1.amazoncognito.com/logout');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('logout_uri')).toBe('https://app.test/login');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });
});

describe('POST /api/auth/login with Cognito configured', () => {
  it('answers 410 without checking the local password', async () => {
    dbMocks.verifyCredentials.mockResolvedValue({ userid: 1, username: 'nathan', role: 'researcher' });
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
    app.use(authRoutes());
    const res = await request(app).post('/api/auth/login').send({ username: 'nathan', password: 'correct-horse' });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('use_cognito');
    expect(dbMocks.verifyCredentials).not.toHaveBeenCalled();
  });
});
