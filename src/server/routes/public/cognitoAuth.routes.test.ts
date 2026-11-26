// Cognito sign-in routes (ai-therapist-387): start stashes PKCE, state and
// nonce; the callback establishes the app session for the local account the
// token maps to, takes the role from the pool's role group, and refuses
// anything it cannot pin to one account and one role; logout ends both sessions.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { createHash } from 'node:crypto';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_TestPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'client123');
vi.stubEnv('COGNITO_DOMAIN', 'https://study-test.auth.us-west-1.amazoncognito.com');
vi.stubEnv('APP_URL', 'https://app.test');

const dbMocks = vi.hoisted(() => ({
  getUserByCognitoSub: vi.fn(),
  getUserByUsernameForCognito: vi.fn(),
  setCognitoSub: vi.fn(),
  syncRoleFromCognito: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const cognitoMocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  verifyIdToken: vi.fn(),
}));
vi.mock('../../services/cognito.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cognito.service.js')>();
  return { ...actual, ...cognitoMocks };
});

const { CognitoError } = await import('../../services/cognito.service.js');
const { default: cognitoAuthRoutes } = await import('./cognitoAuth.routes.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.post('/test/seed', (req, res) => {
    req.session.userId = 1;
    req.session.userRole = 'caseworker';
    req.session.orgId = 99;
    req.session.consentAccepted = true;
    res.json({ ok: true });
  });
  app.get('/test/session', (req, res) => {
    res.json({
      userId: req.session.userId ?? null,
      username: req.session.username ?? null,
      userRole: req.session.userRole ?? null,
      orgId: req.session.orgId ?? null,
      isSandbox: req.session.isSandbox ?? null,
      consentAccepted: req.session.consentAccepted ?? null,
      mfaVerified: req.session.mfaVerified ?? null,
      pending: req.session.cognitoAuth ?? null,
    });
  });
  app.use(cognitoAuthRoutes());
  return app;
}

const SUB = '11111111-2222-3333-4444-555555555555';
const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'x',
  sub: SUB,
  aud: 'client123',
  token_use: 'id',
  'cognito:username': 'p0042',
  'cognito:groups': ['participant'],
  iat: 0,
  exp: 0,
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  userid: 7,
  username: 'p0042',
  role: 'participant',
  organization_id: 3,
  is_sandbox: false,
  cognito_sub: SUB,
  ...over,
});

/** Run /start and return the agent plus what the redirect carried. */
async function started(app = makeApp()) {
  const agent = request.agent(app);
  const res = await agent.get('/api/auth/cognito/start');
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location);
  return { agent, url, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')! };
}

beforeEach(() => {
  vi.clearAllMocks();
  cognitoMocks.exchangeCode.mockResolvedValue({ id_token: 'the.id.token' });
  cognitoMocks.verifyIdToken.mockResolvedValue(claims());
  dbMocks.getUserByCognitoSub.mockResolvedValue(row());
  dbMocks.getUserByUsernameForCognito.mockResolvedValue(null);
});

describe('GET /api/auth/cognito/config', () => {
  it('reports that Cognito sign-in is on', async () => {
    const res = await request(makeApp()).get('/api/auth/cognito/config');
    expect(res.body).toEqual({ enabled: true });
  });
});

describe('GET /api/auth/cognito/start', () => {
  it('redirects to the hosted page and keeps the PKCE verifier matching the challenge', async () => {
    const { agent, url, state, nonce } = await started();
    expect(url.origin + url.pathname).toBe('https://study-test.auth.us-west-1.amazoncognito.com/oauth2/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const { pending } = (await agent.get('/test/session')).body;
    expect(pending.state).toBe(state);
    expect(pending.nonce).toBe(nonce);
    expect(createHash('sha256').update(pending.verifier, 'ascii').digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
  });

  it('issues a fresh state and nonce each time', async () => {
    const a = await started();
    const b = await started();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('GET /api/auth/cognito/callback', () => {
  it('signs a participant in on a fresh session id and carries browser state over', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/test/seed');
    const first = await agent.get('/api/auth/cognito/start');
    const before = String(first.headers['set-cookie'] ?? '');
    const state = new URL(first.headers.location).searchParams.get('state')!;
    const nonce = new URL(first.headers.location).searchParams.get('nonce')!;
    const { pending } = (await agent.get('/test/session')).body;

    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(cognitoMocks.exchangeCode).toHaveBeenCalledWith('c1', pending.verifier);
    expect(cognitoMocks.verifyIdToken).toHaveBeenCalledWith('the.id.token', nonce);
    // A new session cookie was issued (session fixation).
    expect(String(res.headers['set-cookie'])).toContain('connect.sid=');
    expect(String(res.headers['set-cookie'])).not.toBe(before);

    const s = (await agent.get('/test/session')).body;
    expect(s).toMatchObject({
      userId: 7,
      username: 'p0042',
      userRole: 'participant',
      orgId: 3,
      isSandbox: false,
      consentAccepted: true,
      mfaVerified: true,
      pending: null,
    });
  });

  it.each(['therapist', 'researcher', 'caseworker'])('lands %s on /admin', async (role) => {
    cognitoMocks.verifyIdToken.mockResolvedValue(claims({ 'cognito:groups': [role] }));
    dbMocks.getUserByCognitoSub.mockResolvedValue(row({ role }));
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/admin');
  });

  it('links the local row by username on the first sign-in', async () => {
    dbMocks.getUserByCognitoSub.mockResolvedValue(null);
    dbMocks.getUserByUsernameForCognito.mockResolvedValue(row({ cognito_sub: null }));
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/');
    expect(dbMocks.setCognitoSub).toHaveBeenCalledWith(7, SUB);
    expect((await agent.get('/test/session')).body.userId).toBe(7);
  });

  it('refuses a username whose row is linked to another Cognito subject', async () => {
    dbMocks.getUserByCognitoSub.mockResolvedValue(null);
    dbMocks.getUserByUsernameForCognito.mockResolvedValue(row({ cognito_sub: 'someone-else' }));
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/login?error=no_account');
    expect(dbMocks.setCognitoSub).not.toHaveBeenCalled();
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it('refuses a pool account with no local row', async () => {
    dbMocks.getUserByCognitoSub.mockResolvedValue(null);
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/login?error=no_account');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it.each([
    ['no role group', []],
    ['two role groups', ['participant', 'researcher']],
    ['only an unknown group', ['admin']],
  ])('refuses an account with %s, without touching the local row', async (_label, groups) => {
    cognitoMocks.verifyIdToken.mockResolvedValue(claims({ 'cognito:groups': groups }));
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/login?error=no_role');
    expect(dbMocks.getUserByCognitoSub).not.toHaveBeenCalled();
    expect(dbMocks.syncRoleFromCognito).not.toHaveBeenCalled();
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it('copies a changed role from the pool into the local row and the session', async () => {
    cognitoMocks.verifyIdToken.mockResolvedValue(claims({ 'cognito:groups': ['therapist'] }));
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(dbMocks.syncRoleFromCognito).toHaveBeenCalledWith(7, 'therapist');
    expect(res.headers.location).toBe('/admin');
    expect((await agent.get('/test/session')).body.userRole).toBe('therapist');
  });

  it('refuses a state that does not match, and a callback with no sign-in in flight', async () => {
    const { agent } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state: 'forged' });
    expect(res.headers.location).toBe('/login?error=state_mismatch');
    expect(cognitoMocks.exchangeCode).not.toHaveBeenCalled();

    const cold = await request(makeApp()).get('/api/auth/cognito/callback').query({ code: 'c1', state: 'x' });
    expect(cold.headers.location).toBe('/login?error=state_mismatch');
  });

  it('uses a state once: replaying the callback is refused', async () => {
    const { agent, state } = await started();
    await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    const again = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(again.headers.location).toBe('/login?error=state_mismatch');
    expect(cognitoMocks.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('refuses a state older than its lifetime', async () => {
    const { agent, state } = await started();
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 11 * 60 * 1000);
    try {
      const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
      expect(res.headers.location).toBe('/login?error=state_mismatch');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses repeated query parameters instead of treating them as strings', async () => {
    const { agent, state } = await started();
    const res = await agent.get(`/api/auth/cognito/callback?code=a&code=b&state=${state}`);
    expect(res.headers.location).toBe('/login?error=state_mismatch');
    expect(cognitoMocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a token that fails verification', async () => {
    cognitoMocks.verifyIdToken.mockResolvedValue(null);
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/login?error=invalid_token');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it('reports a refused code exchange and an error from the hosted page without echoing them', async () => {
    cognitoMocks.exchangeCode.mockRejectedValue(new CognitoError(400, 'invalid_grant'));
    const a = await started();
    const res = await a.agent.get('/api/auth/cognito/callback').query({ code: 'c1', state: a.state });
    expect(res.headers.location).toBe('/login?error=sign_in_failed');

    const b = await started();
    const denied = await b.agent
      .get('/api/auth/cognito/callback')
      .query({ error: 'access_denied<script>', state: b.state });
    expect(denied.headers.location).toBe('/login?error=sign_in_failed');
    // The pending attempt is spent either way.
    expect((await b.agent.get('/test/session')).body.pending).toBeNull();
  });

  it('reports a server error when the account lookup throws', async () => {
    dbMocks.getUserByCognitoSub.mockRejectedValue(new Error('db down'));
    const { agent, state } = await started();
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
    expect(res.headers.location).toBe('/login?error=server_error');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });
});

describe('GET /api/auth/cognito/logout', () => {
  it('ends the app session and sends the browser to the hosted logout', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/test/seed');
    const res = await agent.get('/api/auth/cognito/logout');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://study-test.auth.us-west-1.amazoncognito.com/logout');
    expect(url.searchParams.get('logout_uri')).toBe('https://app.test/login');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });
});
