// Staff must sign in with an authenticator-app code under Cognito
// (ai-therapist-396). The pool cannot require one per role, so the callback
// holds a staff sign-in whose pool account has none and these routes enrol
// one. The pool calls are mocked: nothing here has run against a real pool.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_TestPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'client123');
vi.stubEnv('COGNITO_DOMAIN', 'https://study-test.auth.us-west-1.amazoncognito.com');
vi.stubEnv('APP_URL', 'https://app.test');

const dbMocks = vi.hoisted(() => ({
  getUserByCognitoSub: vi.fn(),
  getUserById: vi.fn(),
  getUserByUsernameForCognito: vi.fn(),
  setCognitoSub: vi.fn(),
  syncRoleFromCognito: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

const cognitoMocks = vi.hoisted(() => ({ exchangeCode: vi.fn(), verifyIdToken: vi.fn() }));
vi.mock('../../services/cognito.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cognito.service.js')>();
  return { ...actual, ...cognitoMocks };
});

const adminMocks = vi.hoisted(() => ({
  getTotpEnabled: vi.fn(),
  beginTotpEnrolment: vi.fn(),
  verifyTotpEnrolment: vi.fn(),
  setTotpEnabled: vi.fn(),
}));
vi.mock('../../services/cognitoAdmin.service.js', () => adminMocks);

const qrMock = vi.hoisted(() => ({ generateQRCode: vi.fn() }));
vi.mock('../../services/mfa.service.js', () => qrMock);

const { default: cognitoAuthRoutes } = await import('./cognitoAuth.routes.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.post('/test/seed', (req, res) => {
    req.session.consentAccepted = true;
    req.session.ownedSessions = ['anon-1'];
    res.json({ ok: true });
  });
  app.get('/test/session', (req, res) => {
    res.json({
      userId: req.session.userId ?? null,
      userRole: req.session.userRole ?? null,
      mfaVerified: req.session.mfaVerified ?? null,
      ownedSessions: req.session.ownedSessions ?? null,
      enrol: req.session.cognitoEnrol ?? null,
    });
  });
  app.post('/test/age-enrol', (req, res) => {
    if (req.session.cognitoEnrol) req.session.cognitoEnrol.startedAt = Date.now() - 16 * 60 * 1000;
    res.json({ ok: true });
  });
  app.use(cognitoAuthRoutes());
  return app;
}

const SUB = '11111111-2222-3333-4444-555555555555';
const staffRow = (over: Record<string, unknown> = {}) => ({
  userid: 9,
  username: 'dr_one',
  role: 'therapist',
  organization_id: 3,
  is_sandbox: false,
  cognito_sub: SUB,
  ...over,
});
const claimsFor = (role: string) => ({
  iss: 'x',
  sub: SUB,
  aud: 'client123',
  token_use: 'id',
  'cognito:username': 'dr_one',
  'cognito:groups': [role],
  iat: 0,
  exp: 0,
});

/** Sign in through start + callback; returns the agent and the callback answer. */
async function signIn(app = makeApp(), agent = request.agent(app)) {
  const start = await agent.get('/api/auth/cognito/start');
  const state = new URL(start.headers.location).searchParams.get('state')!;
  const res = await agent.get('/api/auth/cognito/callback').query({ code: 'c1', state });
  return { agent, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  cognitoMocks.exchangeCode.mockResolvedValue({ id_token: 'the.id.token', access_token: 'ACCESS-1' });
  cognitoMocks.verifyIdToken.mockResolvedValue(claimsFor('therapist'));
  dbMocks.getUserByCognitoSub.mockResolvedValue(staffRow());
  dbMocks.getUserById.mockResolvedValue(staffRow());
  adminMocks.getTotpEnabled.mockResolvedValue(false);
  adminMocks.beginTotpEnrolment.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP' });
  adminMocks.verifyTotpEnrolment.mockResolvedValue(true);
  adminMocks.setTotpEnabled.mockResolvedValue(undefined);
  qrMock.generateQRCode.mockResolvedValue('data:image/png;base64,QR');
});

describe('callback: the second-factor rule', () => {
  it.each(['therapist', 'researcher', 'caseworker'])(
    'signs %s in when the pool account has an authenticator app',
    async (role) => {
      cognitoMocks.verifyIdToken.mockResolvedValue(claimsFor(role));
      dbMocks.getUserByCognitoSub.mockResolvedValue(staffRow({ role }));
      adminMocks.getTotpEnabled.mockResolvedValue(true);
      const { agent, res } = await signIn();
      expect(res.headers.location).toBe('/admin');
      expect(adminMocks.getTotpEnabled).toHaveBeenCalledWith('dr_one');
      const s = (await agent.get('/test/session')).body;
      expect(s.userId).toBe(9);
      expect(s.enrol).toBeNull();
    },
  );

  it.each(['therapist', 'researcher', 'caseworker'])(
    'holds %s without an authenticator app: no session, only the enrolment state',
    async (role) => {
      cognitoMocks.verifyIdToken.mockResolvedValue(claimsFor(role));
      dbMocks.getUserByCognitoSub.mockResolvedValue(staffRow({ role }));
      const { agent, res } = await signIn();
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login?enrol=totp');
      const s = (await agent.get('/test/session')).body;
      expect(s.userId).toBeNull();
      expect(s.userRole).toBeNull();
      expect(s.mfaVerified).toBeNull();
      expect(s.enrol).toMatchObject({ userId: 9, username: 'dr_one', accessToken: 'ACCESS-1', attempts: 0 });
    },
  );

  it.each(['participant', 'demo'])('does not ask the pool about %s accounts', async (role) => {
    cognitoMocks.verifyIdToken.mockResolvedValue(claimsFor(role));
    dbMocks.getUserByCognitoSub.mockResolvedValue(staffRow({ role }));
    const { agent, res } = await signIn();
    expect(res.headers.location).toBe('/');
    expect(adminMocks.getTotpEnabled).not.toHaveBeenCalled();
    expect((await agent.get('/test/session')).body.userId).toBe(9);
  });

  it('applies the rule to the role the pool gives, not the stale local role', async () => {
    // Local row still says participant; the pool promoted the account.
    cognitoMocks.verifyIdToken.mockResolvedValue(claimsFor('researcher'));
    dbMocks.getUserByCognitoSub.mockResolvedValue(staffRow({ role: 'participant' }));
    const { agent, res } = await signIn();
    expect(res.headers.location).toBe('/login?enrol=totp');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it('refuses a staff sign-in when the pool cannot be asked (never password-only by default)', async () => {
    adminMocks.getTotpEnabled.mockRejectedValue(new Error('pool down'));
    const { agent, res } = await signIn();
    expect(res.headers.location).toBe('/login?error=server_error');
    const s = (await agent.get('/test/session')).body;
    expect(s.userId).toBeNull();
    expect(s.enrol).toBeNull();
  });

  it('refuses when there is no access token to enrol with', async () => {
    cognitoMocks.exchangeCode.mockResolvedValue({ id_token: 'the.id.token' });
    const { agent, res } = await signIn();
    expect(res.headers.location).toBe('/login?error=server_error');
    expect((await agent.get('/test/session')).body.enrol).toBeNull();
  });

  it('drops what the browser session held before (a held sign-in is a fresh session)', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/test/seed');
    await signIn(app, agent);
    expect((await agent.get('/test/session')).body.ownedSessions).toBeNull();
  });
});

describe('enrolment routes', () => {
  it('report nothing pending and refuse without a held sign-in', async () => {
    const agent = request.agent(makeApp());
    expect((await agent.get('/api/auth/cognito/totp/status')).body).toEqual({ pending: false });
    const begin = await agent.post('/api/auth/cognito/totp/begin');
    expect(begin.status).toBe(401);
    expect(begin.body.code).toBe('enrol_expired');
    const verify = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(verify.status).toBe(401);
    expect(adminMocks.beginTotpEnrolment).not.toHaveBeenCalled();
    expect(adminMocks.verifyTotpEnrolment).not.toHaveBeenCalled();
  });

  it('begin: asks the pool for a secret with the held access token and returns a QR code', async () => {
    const { agent } = await signIn();
    expect((await agent.get('/api/auth/cognito/totp/status')).body).toEqual({ pending: true, username: 'dr_one' });
    const res = await agent.post('/api/auth/cognito/totp/begin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ secret: 'JBSWY3DPEHPK3PXP', qrCode: 'data:image/png;base64,QR' });
    expect(adminMocks.beginTotpEnrolment).toHaveBeenCalledWith('ACCESS-1');
    const url = new URL(qrMock.generateQRCode.mock.calls[0][0] as string);
    expect(url.protocol).toBe('otpauth:');
    expect(decodeURIComponent(url.pathname)).toContain('AI Therapist:dr_one');
    expect(url.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(url.searchParams.get('issuer')).toBe('AI Therapist');
    // The access token is never sent to the browser.
    expect(JSON.stringify(res.body)).not.toContain('ACCESS-1');
  });

  it('begin: a pool failure is a 502 and no secret', async () => {
    adminMocks.beginTotpEnrolment.mockRejectedValue(new Error('pool down'));
    const { agent } = await signIn();
    const res = await agent.post('/api/auth/cognito/totp/begin');
    expect(res.status).toBe(502);
    expect(res.body.secret).toBeUndefined();
  });

  it('verify: a right code switches the challenge on, then establishes the session', async () => {
    const order: string[] = [];
    adminMocks.verifyTotpEnrolment.mockImplementation(async () => {
      order.push('verify');
      return true;
    });
    adminMocks.setTotpEnabled.mockImplementation(async () => void order.push('enable'));
    const { agent } = await signIn();
    const res = await agent.post('/api/auth/cognito/totp/verify').send({ code: ' 123456 ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, redirect: '/admin' });
    expect(order).toEqual(['verify', 'enable']);
    expect(adminMocks.verifyTotpEnrolment).toHaveBeenCalledWith('ACCESS-1', '123456');
    expect(adminMocks.setTotpEnabled).toHaveBeenCalledWith('dr_one', true);
    const s = (await agent.get('/test/session')).body;
    expect(s).toMatchObject({ userId: 9, userRole: 'therapist', mfaVerified: true });
    // The enrolment state, and with it the access token, is gone.
    expect(s.enrol).toBeNull();
  });

  it('verify: a wrong code signs nobody in, enables nothing, and can be retried', async () => {
    adminMocks.verifyTotpEnrolment.mockResolvedValueOnce(false);
    const { agent } = await signIn();
    const bad = await agent.post('/api/auth/cognito/totp/verify').send({ code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('code_mismatch');
    expect(adminMocks.setTotpEnabled).not.toHaveBeenCalled();
    expect((await agent.get('/test/session')).body.userId).toBeNull();
    const good = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(good.status).toBe(200);
  });

  it.each([[''], ['12345'], ['1234567'], ['abcdef'], [123456]])('verify: refuses a malformed code %j', async (code) => {
    const { agent } = await signIn();
    const res = await agent.post('/api/auth/cognito/totp/verify').send({ code });
    expect(res.status).toBe(400);
    expect(adminMocks.verifyTotpEnrolment).not.toHaveBeenCalled();
  });

  it('verify: stops after eight tries; the sign-in has to start over', async () => {
    adminMocks.verifyTotpEnrolment.mockResolvedValue(false);
    const { agent } = await signIn();
    for (let i = 0; i < 8; i++) {
      expect((await agent.post('/api/auth/cognito/totp/verify').send({ code: '000000' })).body.code).toBe(
        'code_mismatch',
      );
    }
    adminMocks.verifyTotpEnrolment.mockResolvedValue(true);
    const res = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('enrol_expired');
    expect(adminMocks.verifyTotpEnrolment).toHaveBeenCalledTimes(8);
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it('verify: refuses a held sign-in older than its lifetime', async () => {
    const { agent } = await signIn();
    await agent.post('/test/age-enrol');
    const res = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(res.status).toBe(401);
    expect(adminMocks.verifyTotpEnrolment).not.toHaveBeenCalled();
    expect((await agent.get('/api/auth/cognito/totp/status')).body).toEqual({ pending: false });
  });

  it('verify: a pool failure (verifying or switching on) signs nobody in', async () => {
    adminMocks.setTotpEnabled.mockRejectedValue(new Error('pool down'));
    const { agent } = await signIn();
    const res = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(res.status).toBe(502);
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it.each([
    ['was deleted', null],
    ['was renamed', { username: 'someone_else' }],
    ['is no longer staff', { role: 'participant' }],
  ])('verify: refuses when the account %s while enrolling', async (_label, change) => {
    const { agent } = await signIn();
    dbMocks.getUserById.mockResolvedValue(change === null ? null : staffRow(change));
    const res = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(res.status).toBe(401);
    const s = (await agent.get('/test/session')).body;
    expect(s.userId).toBeNull();
    expect(s.enrol).toBeNull();
  });
});
