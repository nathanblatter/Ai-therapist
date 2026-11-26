// The whole Cognito sign-in path with only the network and the database
// replaced (ai-therapist-387, 396). The other route tests mock the token
// exchange and the ID-token verifier; this one runs them: a stand-in token
// endpoint signs a real RS256 ID token, the real verifier checks it against
// a stand-in JWKS, and a stand-in pool client answers the admin calls. It
// pins the seams between the modules: the nonce travels start -> token ->
// verifier, the access token reaches the enrolment call and nothing else,
// and a staff account is held until its authenticator is on.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_FlowPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'flowclient');
vi.stubEnv('COGNITO_CLIENT_SECRET', '');
vi.stubEnv('COGNITO_DOMAIN', 'https://flow.auth.us-west-1.amazoncognito.com');
vi.stubEnv('APP_URL', 'https://app.test');

const users = new Map<number, Record<string, unknown>>();
const dbMocks = vi.hoisted(() => ({
  getCognitoTotpEnrolledAt: vi.fn(),
  setCognitoTotpEnrolledAt: vi.fn(),
  getUserByCognitoSub: vi.fn(),
  getUserById: vi.fn(),
  getUserByUsernameForCognito: vi.fn(),
  setCognitoSub: vi.fn(),
  syncRoleFromCognito: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);
vi.mock('../../services/researcherEmail.service.js', () => ({ clearEmailIfIneligible: vi.fn() }));

const cognito = await import('../../services/cognito.service.js');
const admin = await import('../../services/cognitoAdmin.service.js');
const { default: cognitoAuthRoutes } = await import('./cognitoAuth.routes.js');

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** What the stand-in hosted page "signed in": set per test. */
let hosted: {
  username: string;
  group: string;
  nonce?: string;
  signWith?: typeof pair.privateKey;
  /** When the hosted page authenticated the person (seconds); default now. */
  authTime?: number;
};
let tokenBodies: URLSearchParams[] = [];
/** The pool: which usernames have the authenticator challenge on. */
const totpOn = new Set<string>();
let poolCalls: { name: string; input: Record<string, unknown> }[] = [];

function mintIdToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cognito.ISSUER,
    sub: `sub-${hosted.username}`,
    aud: 'flowclient',
    token_use: 'id',
    nonce: hosted.nonce ?? nonce,
    auth_time: hosted.authTime ?? now,
    'cognito:username': hosted.username,
    'cognito:groups': [hosted.group],
    iat: now,
    exp: now + 3600,
  };
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(input, 'ascii'), hosted.signWith ?? pair.privateKey);
  return `${input}.${sig.toString('base64url')}`;
}

/** The nonce the app sent to the hosted page, by the code handed back. */
const nonceByCode = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  users.clear();
  users.set(1, { userid: 1, username: 'dr_flow', role: 'therapist', organization_id: 3, is_sandbox: false });
  users.set(2, { userid: 2, username: 'p_flow', role: 'participant', organization_id: 3, is_sandbox: false });
  const byName = (name: string) => [...users.values()].find((u) => u.username === name) ?? null;
  dbMocks.getUserByCognitoSub.mockImplementation(
    async (sub: string) => [...users.values()].find((u) => u.cognito_sub === sub) ?? null,
  );
  dbMocks.getUserByUsernameForCognito.mockImplementation(async (name: string) => byName(name));
  dbMocks.getUserById.mockImplementation(async (id: number) => users.get(Number(id)) ?? null);
  dbMocks.setCognitoSub.mockImplementation(async (id: number, sub: string) => {
    const u = users.get(Number(id));
    if (u) u.cognito_sub = sub;
  });
  dbMocks.getCognitoTotpEnrolledAt.mockImplementation(
    async (id: number) => (users.get(Number(id))?.cognito_totp_enrolled_at as Date | undefined) ?? null,
  );
  dbMocks.setCognitoTotpEnrolledAt.mockImplementation(async (id: number, at: Date | null) => {
    const u = users.get(Number(id));
    if (u) u.cognito_totp_enrolled_at = at;
  });
  hosted = { username: 'dr_flow', group: 'therapist' };
  tokenBodies = [];
  totpOn.clear();
  poolCalls = [];
  nonceByCode.clear();
  cognito._resetJwks();
  cognito._setFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${cognito.ISSUER}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), { status: 200 });
    }
    if (url === 'https://flow.auth.us-west-1.amazoncognito.com/oauth2/token') {
      const body = new URLSearchParams(String(init?.body));
      tokenBodies.push(body);
      const nonce = nonceByCode.get(body.get('code') ?? '');
      if (nonce === undefined) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response(
        JSON.stringify({ id_token: mintIdToken(nonce), access_token: `access-for-${hosted.username}` }),
        { status: 200 },
      );
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  }) as typeof fetch);
  admin._setClient({
    send: async (command: unknown) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      const name = c.constructor.name.replace(/Command$/, '');
      poolCalls.push({ name, input: c.input });
      if (name === 'AdminGetUser') {
        return { UserMFASettingList: totpOn.has(String(c.input.Username)) ? ['SOFTWARE_TOKEN_MFA'] : [] };
      }
      if (name === 'AssociateSoftwareToken') return { SecretCode: 'JBSWY3DPEHPK3PXP' };
      if (name === 'VerifySoftwareToken') {
        if (c.input.UserCode !== '123456') throw Object.assign(new Error('no'), { name: 'CodeMismatchException' });
        return { Status: 'SUCCESS' };
      }
      if (name === 'AdminSetUserMFAPreference') {
        const on = (c.input.SoftwareTokenMfaSettings as { Enabled?: boolean } | undefined)?.Enabled === true;
        if (on) totpOn.add(String(c.input.Username));
        else totpOn.delete(String(c.input.Username));
      }
      return {};
    },
  });
});

afterAll(() => admin._setClient(null));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.get('/test/session', (req, res) => {
    res.json({
      userId: req.session.userId ?? null,
      userRole: req.session.userRole ?? null,
      held: Boolean(req.session.cognitoEnrol),
    });
  });
  app.use(cognitoAuthRoutes());
  return app;
}

/** Browser leg: /start, the hosted page "signs in" and hands back a code, /callback. */
async function signIn(agent: ReturnType<typeof request.agent>, code = 'code-1') {
  const start = await agent.get('/api/auth/cognito/start');
  const authorize = new URL(start.headers.location);
  expect(authorize.searchParams.get('scope')).toBe('openid aws.cognito.signin.user.admin');
  nonceByCode.set(code, authorize.searchParams.get('nonce')!);
  return agent.get('/api/auth/cognito/callback').query({ code, state: authorize.searchParams.get('state') });
}

describe('Cognito sign-in, end to end over the real token verifier', () => {
  it('a participant signs in: code exchanged with the PKCE verifier, token verified, row linked', async () => {
    hosted = { username: 'p_flow', group: 'participant' };
    const agent = request.agent(makeApp());
    const res = await signIn(agent);
    expect(res.headers.location).toBe('/');
    expect((await agent.get('/test/session')).body).toEqual({ userId: 2, userRole: 'participant', held: false });
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0].get('grant_type')).toBe('authorization_code');
    expect(tokenBodies[0].get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(users.get(2)?.cognito_sub).toBe('sub-p_flow');
    // No pool admin call for a role that needs no second factor.
    expect(poolCalls).toEqual([]);
  });

  it('a staff member with no authenticator is held, enrols, and is then signed in', async () => {
    const agent = request.agent(makeApp());
    const res = await signIn(agent);
    expect(res.headers.location).toBe('/login?enrol=totp');
    expect((await agent.get('/test/session')).body).toEqual({ userId: null, userRole: null, held: true });

    const begin = await agent.post('/api/auth/cognito/totp/begin');
    expect(begin.status).toBe(200);
    expect(begin.body.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(begin.body.qrCode).toMatch(/^data:image\/png;base64,/);

    const wrong = await agent.post('/api/auth/cognito/totp/verify').send({ code: '000000' });
    expect(wrong.status).toBe(401);
    expect((await agent.get('/test/session')).body.userId).toBeNull();

    const right = await agent.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(right.body).toEqual({ success: true, redirect: '/admin' });
    expect((await agent.get('/test/session')).body).toEqual({ userId: 1, userRole: 'therapist', held: false });

    // The access token of that sign-in went to the two enrolment calls only.
    const withToken = poolCalls.filter((c) => 'AccessToken' in c.input);
    expect(withToken.map((c) => c.name)).toEqual([
      'AssociateSoftwareToken',
      'VerifySoftwareToken',
      'VerifySoftwareToken',
    ]);
    expect(withToken.every((c) => c.input.AccessToken === 'access-for-dr_flow')).toBe(true);
    expect(poolCalls.at(-1)).toMatchObject({
      name: 'AdminSetUserMFAPreference',
      input: { Username: 'dr_flow', SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } },
    });
  });

  it('a hosted-page sign-in from before the enrolment cannot ride in on it afterwards', async () => {
    // The attacker authenticated at the hosted page (password only) while the
    // account had no authenticator. The owner then enrols through the app.
    const stale = Math.floor(Date.now() / 1000) - 600;
    const owner = request.agent(makeApp());
    await signIn(owner, 'owner-code');
    await owner.post('/api/auth/cognito/totp/begin');
    await owner.post('/api/auth/cognito/totp/verify').send({ code: '123456' });
    expect(users.get(1)?.cognito_totp_enrolled_at).toBeInstanceOf(Date);

    hosted = { username: 'dr_flow', group: 'therapist', authTime: stale };
    const attacker = request.agent(makeApp());
    const res = await signIn(attacker, 'attacker-code');
    expect(new URL(res.headers.location).pathname).toBe('/logout');
    expect((await attacker.get('/test/session')).body).toEqual({ userId: null, userRole: null, held: false });

    // The owner's next real sign-in (authenticated now, with a code) is fine.
    hosted = { username: 'dr_flow', group: 'therapist', authTime: Math.floor(Date.now() / 1000) + 5 };
    const again = request.agent(makeApp());
    expect((await signIn(again, 'owner-code-2')).headers.location).toBe('/admin');
  });

  it('once enrolled, the next staff sign-in goes straight in', async () => {
    totpOn.add('dr_flow');
    const agent = request.agent(makeApp());
    const res = await signIn(agent);
    expect(res.headers.location).toBe('/admin');
    expect((await agent.get('/test/session')).body).toEqual({ userId: 1, userRole: 'therapist', held: false });
    expect(poolCalls.map((c) => c.name)).toEqual(['AdminGetUser']);
  });

  it('refuses a token minted for another sign-in attempt (nonce) and one signed by another key', async () => {
    hosted = { username: 'p_flow', group: 'participant', nonce: 'someone-elses-nonce' };
    let agent = request.agent(makeApp());
    expect((await signIn(agent)).headers.location).toBe('/login?error=invalid_token');
    expect((await agent.get('/test/session')).body.userId).toBeNull();

    hosted = { username: 'p_flow', group: 'participant', signWith: stranger.privateKey };
    agent = request.agent(makeApp());
    expect((await signIn(agent, 'code-2')).headers.location).toBe('/login?error=invalid_token');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });

  it('refuses a code the hosted page never issued', async () => {
    const agent = request.agent(makeApp());
    const start = await agent.get('/api/auth/cognito/start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const res = await agent.get('/api/auth/cognito/callback').query({ code: 'made-up', state });
    expect(res.headers.location).toBe('/login?error=sign_in_failed');
  });

  it('a pool account promoted to staff is held even though the local row still says participant', async () => {
    hosted = { username: 'p_flow', group: 'researcher' };
    const agent = request.agent(makeApp());
    expect((await signIn(agent)).headers.location).toBe('/login?enrol=totp');
    expect(dbMocks.syncRoleFromCognito).toHaveBeenCalledWith(2, 'researcher');
    expect((await agent.get('/test/session')).body.userId).toBeNull();
  });
});
