// Squawk sign-in routes (auth-service-33): the callback establishes the app
// session for the local account the token maps to, the owner maps to the
// configured researcher, roles sync from the token, and the ceremony proxies
// relay Squawk's refusals cleanly.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

vi.stubEnv('SQUAWK_ISSUER', 'https://squawk.test');
vi.stubEnv('SQUAWK_SERVICE_ID', 'svc_test');
vi.stubEnv('SQUAWK_CREDENTIAL', 'nbc_cred');
vi.stubEnv('SQUAWK_CLIENT_ID', 'nbc_client');
vi.stubEnv('SQUAWK_RESOURCE', 'https://app.test/api');
vi.stubEnv('SQUAWK_OWNER_USERNAME', 'nathan');
vi.stubEnv('APP_URL', 'https://app.test');

const dbMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUserBySquawkId: vi.fn(),
  getUserByUsernameForLogin: vi.fn(),
  setSquawkUserId: vi.fn(),
  syncRoleFromSquawk: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const squawkMocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  verifyAccessToken: vi.fn(),
  loginPassword: vi.fn(),
  loginPasskeyBegin: vi.fn(),
}));
vi.mock('../../services/squawk.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/squawk.service.js')>();
  return { ...actual, ...squawkMocks };
});

const { default: squawkAuthRoutes } = await import('./squawkAuth.routes.js');

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
    });
  });
  app.use(squawkAuthRoutes());
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

describe('GET /api/auth/squawk/start', () => {
  it('sends the browser to Squawk with PKCE and remembers the state on the session', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/auth/squawk/start');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://squawk.test/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('nbc_client');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://app.test/api/auth/squawk/callback');
    expect(loc.searchParams.get('resource')).toBe('https://app.test/api');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('scope')).toContain('role:participant');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(res.headers['set-cookie']).toBeDefined();
  });
});

describe('GET /api/auth/squawk/callback', () => {
  async function startedSession(app: express.Express): Promise<{ sid: string; state: string }> {
    const res = await request(app).get('/api/auth/squawk/start');
    const state = new URL(res.headers.location).searchParams.get('state')!;
    return { sid: sidOf(res.headers['set-cookie']), state };
  }

  it('signs a user in on a fresh session id, linking by username on the first login', async () => {
    const app = makeApp();
    const { sid, state } = await startedSession(app);
    await request(app).post('/test/seed').set('Cookie', sid);
    squawkMocks.exchangeCode.mockResolvedValue({ access_token: 'tok' });
    squawkMocks.verifyAccessToken.mockResolvedValue({
      iss: 'https://squawk.test',
      sub: 'usr:abc',
      aud: 'svc_test',
      scope: 'role:therapist',
      preferred_username: 'p0042',
      iat: 1,
      exp: 2,
    });
    dbMocks.getUserBySquawkId.mockResolvedValue(null);
    dbMocks.getUserByUsernameForLogin.mockResolvedValue({
      userid: 7,
      username: 'p0042',
      role: 'participant',
      organization_id: 3,
      is_sandbox: false,
      squawk_user_id: null,
    });

    const res = await request(app).get(`/api/auth/squawk/callback?code=c1&state=${state}`).set('Cookie', sid);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
    expect(squawkMocks.exchangeCode).toHaveBeenCalledWith('c1', expect.any(String));
    expect(dbMocks.setSquawkUserId).toHaveBeenCalledWith(7, 'abc');
    expect(dbMocks.syncRoleFromSquawk).toHaveBeenCalledWith(7, 'therapist');

    const newSid = sidOf(res.headers['set-cookie']);
    expect(newSid).not.toBe(sid);
    const s = await request(app).get('/test/session').set('Cookie', newSid);
    expect(s.body).toMatchObject({
      userId: 7,
      username: 'p0042',
      userRole: 'therapist',
      orgId: 3,
      isSandbox: false,
      consentAccepted: true,
      mfaVerified: true,
    });
  });

  it('maps the owner passkey to the configured researcher account', async () => {
    const app = makeApp();
    const { sid, state } = await startedSession(app);
    squawkMocks.exchangeCode.mockResolvedValue({ access_token: 'tok' });
    squawkMocks.verifyAccessToken.mockResolvedValue({
      iss: 'https://squawk.test',
      sub: 'owner',
      aud: 'svc_test',
      scope: 'role:therapist role:researcher',
      iat: 1,
      exp: 2,
    });
    dbMocks.getUserByUsernameForLogin.mockResolvedValue({
      userid: 1,
      username: 'nathan',
      role: 'researcher',
      organization_id: 1,
      is_sandbox: false,
      squawk_user_id: null,
    });
    const res = await request(app).get(`/api/auth/squawk/callback?code=c1&state=${state}`).set('Cookie', sid);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
    expect(dbMocks.getUserByUsernameForLogin).toHaveBeenCalledWith('nathan');
    expect(dbMocks.setSquawkUserId).not.toHaveBeenCalled();
    // The owner keeps the local role; scopes are not read for sub=owner.
    expect(dbMocks.syncRoleFromSquawk).not.toHaveBeenCalled();
  });

  it('refuses a mismatched state, a bad token and a token with no local account', async () => {
    const app = makeApp();
    const { sid, state } = await startedSession(app);
    let res = await request(app).get('/api/auth/squawk/callback?code=c1&state=wrong').set('Cookie', sid);
    expect(res.headers.location).toBe('/login?error=state_mismatch');
    // The stash is single use: the right state no longer works either.
    res = await request(app).get(`/api/auth/squawk/callback?code=c1&state=${state}`).set('Cookie', sid);
    expect(res.headers.location).toBe('/login?error=state_mismatch');

    const again = await startedSession(app);
    squawkMocks.exchangeCode.mockResolvedValue({ access_token: 'tok' });
    squawkMocks.verifyAccessToken.mockResolvedValue(null);
    res = await request(app).get(`/api/auth/squawk/callback?code=c1&state=${again.state}`).set('Cookie', again.sid);
    expect(res.headers.location).toBe('/login?error=invalid_token');

    const third = await startedSession(app);
    squawkMocks.verifyAccessToken.mockResolvedValue({
      iss: 'https://squawk.test',
      sub: 'usr:zzz',
      aud: 'svc_test',
      preferred_username: 'ghost',
      iat: 1,
      exp: 2,
    });
    dbMocks.getUserBySquawkId.mockResolvedValue(null);
    dbMocks.getUserByUsernameForLogin.mockResolvedValue(null);
    res = await request(app).get(`/api/auth/squawk/callback?code=c1&state=${third.state}`).set('Cookie', third.sid);
    expect(res.headers.location).toBe('/login?error=no_account');
    const s = await request(app).get('/test/session').set('Cookie', third.sid);
    expect(s.body.userId).toBeNull();
  });

  it('passes an error from Squawk straight to the login page', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/auth/squawk/callback?error=access_denied');
    expect(res.headers.location).toBe('/login?error=access_denied');
  });
});

describe('ceremony proxies', () => {
  it('relays the password ceremony and maps refusals', async () => {
    const app = makeApp();
    const { SquawkError } = await import('../../services/squawk.service.js');
    squawkMocks.loginPassword.mockResolvedValue({
      redirect_to: 'https://app.test/api/auth/squawk/callback?code=x&state=y',
    });
    let res = await request(app)
      .post('/api/auth/squawk/password')
      .send({ login_challenge: 'lc', username: 'p0042', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.redirect_to).toContain('code=x');
    expect(squawkMocks.loginPassword).toHaveBeenCalledWith('lc', 'p0042', 'pw');

    squawkMocks.loginPassword.mockRejectedValue(
      new SquawkError(401, 'password_rejected', 'wrong username or password'),
    );
    res = await request(app)
      .post('/api/auth/squawk/password')
      .send({ login_challenge: 'lc', username: 'p0042', password: 'pw' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password', code: 'password_rejected' });

    squawkMocks.loginPassword.mockRejectedValue(new SquawkError(429, 'too_many_attempts', '', 60));
    res = await request(app)
      .post('/api/auth/squawk/password')
      .send({ login_challenge: 'lc', username: 'p0042', password: 'pw' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');

    squawkMocks.loginPassword.mockRejectedValue(new SquawkError(500, 'server_error'));
    res = await request(app)
      .post('/api/auth/squawk/password')
      .send({ login_challenge: 'lc', username: 'p0042', password: 'pw' });
    expect(res.status).toBe(502);

    res = await request(app).post('/api/auth/squawk/password').send({ username: 'p0042' });
    expect(res.status).toBe(400);
  });

  it('requires a session for passkey registration', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/auth/squawk/passkeys/begin');
    expect(res.status).toBe(401);
  });
});
