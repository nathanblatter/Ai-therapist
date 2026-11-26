// Cognito ID-token verification (ai-therapist-387): RS256 against the pool's
// JWKS, issuer, audience, token_use, lifetime and nonce checks, with the HTTP
// layer swapped for a stub; plus the hosted-page URLs and the role-group rule.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

vi.stubEnv('COGNITO_USER_POOL_ID', 'us-west-1_TestPool1');
vi.stubEnv('COGNITO_CLIENT_ID', 'client123');
vi.stubEnv('COGNITO_CLIENT_SECRET', '');
vi.stubEnv('COGNITO_DOMAIN', 'https://study-test.auth.us-west-1.amazoncognito.com/');
vi.stubEnv('APP_URL', 'https://app.test');

const cognito = await import('./cognito.service.js');

const ISS = 'https://cognito-idp.us-west-1.amazonaws.com/us-west-1_TestPool1';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(claims: Record<string, unknown>, kid = 'k1', alg = 'RS256', key: KeyObject = pair.privateKey): string {
  const signingInput = `${b64({ alg, typ: 'JWT', kid })}.${b64(claims)}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${sig.toString('base64url')}`;
}

const now = 1_800_000_000;
const NONCE = 'nonce-abc';
const good = {
  iss: ISS,
  sub: '11111111-2222-3333-4444-555555555555',
  aud: 'client123',
  token_use: 'id',
  nonce: NONCE,
  'cognito:username': 'p0042',
  'cognito:groups': ['participant'],
  iat: now - 5,
  exp: now + 3600,
};

let jwksCalls = 0;
let tokenRequests: { url: string; init?: RequestInit }[] = [];
let tokenResponse: Response;
beforeEach(() => {
  jwksCalls = 0;
  tokenRequests = [];
  tokenResponse = new Response(JSON.stringify({ id_token: 'x.y.z' }), { status: 200 });
  cognito._resetJwks();
  cognito._setFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISS}/.well-known/jwks.json`) {
      jwksCalls++;
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/oauth2/token')) {
      tokenRequests.push({ url, init });
      return tokenResponse;
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  }) as typeof fetch);
});

describe('configuration', () => {
  it('derives the region and issuer from the pool id and is enabled', () => {
    expect(cognito.REGION).toBe('us-west-1');
    expect(cognito.ISSUER).toBe(ISS);
    expect(cognito.enabled()).toBe(true);
    expect(cognito.redirectUri()).toBe('https://app.test/api/auth/cognito/callback');
  });
});

describe('verifyIdToken', () => {
  it('accepts an ID token signed by a pool key for this app client', async () => {
    const claims = await cognito.verifyIdToken(mint(good), NONCE, now);
    expect(claims?.sub).toBe(good.sub);
    expect(claims?.['cognito:username']).toBe('p0042');
    // The JWKS is cached across verifications.
    await cognito.verifyIdToken(mint(good), NONCE, now);
    expect(jwksCalls).toBe(1);
  });

  it('rejects a tampered signature and a token signed by another key under a known kid', async () => {
    const tampered = mint(good).replace(/\.[^.]+$/, '.AAAA');
    expect(await cognito.verifyIdToken(tampered, NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint(good, 'k1', 'RS256', other.privateKey), NONCE, now)).toBeNull();
  });

  it('rejects a payload swapped under a valid signature', async () => {
    const [h, , s] = mint(good).split('.');
    const forged = `${h}.${b64({ ...good, 'cognito:groups': ['researcher'] })}.${s}`;
    expect(await cognito.verifyIdToken(forged, NONCE, now)).toBeNull();
  });

  it('rejects another issuer, another app client, and an access token', async () => {
    const otherPool = 'https://cognito-idp.us-west-1.amazonaws.com/us-west-1_Other';
    expect(await cognito.verifyIdToken(mint({ ...good, iss: otherPool }), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint({ ...good, aud: 'client999' }), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint({ ...good, token_use: 'access' }), NONCE, now)).toBeNull();
  });

  it('rejects an expired token, one issued in the future, and one without a lifetime', async () => {
    expect(await cognito.verifyIdToken(mint({ ...good, exp: now }), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint({ ...good, iat: now + 600 }), NONCE, now)).toBeNull();
    const { exp: _exp, ...noExp } = good;
    expect(await cognito.verifyIdToken(mint(noExp), NONCE, now)).toBeNull();
  });

  it('rejects a wrong, missing or empty nonce', async () => {
    expect(await cognito.verifyIdToken(mint(good), 'another-nonce', now)).toBeNull();
    const { nonce: _nonce, ...noNonce } = good;
    expect(await cognito.verifyIdToken(mint(noNonce), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint(noNonce), '', now)).toBeNull();
  });

  it('rejects other algorithms, a missing kid, an unknown kid and malformed input', async () => {
    expect(await cognito.verifyIdToken(mint(good, 'k1', 'HS256'), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint(good, 'k1', 'none'), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint(good, ''), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(mint(good, 'k2'), NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken('not.a.jwt', NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken('', NONCE, now)).toBeNull();
    expect(await cognito.verifyIdToken(`${b64(null)}.${b64(null)}.AAAA`, NONCE, now)).toBeNull();
  });

  it('does not refetch the JWKS for every token with an unknown kid', async () => {
    await cognito.verifyIdToken(mint(good), NONCE, now);
    await cognito.verifyIdToken(mint(good, 'k2'), NONCE, now);
    await cognito.verifyIdToken(mint(good, 'k3'), NONCE, now);
    expect(jwksCalls).toBe(1);
  });

  it('rejects a token with no subject', async () => {
    expect(await cognito.verifyIdToken(mint({ ...good, sub: '' }), NONCE, now)).toBeNull();
  });
});

describe('roleFromGroups', () => {
  it('reads the one app role group', () => {
    expect(cognito.roleFromGroups(['therapist'])).toBe('therapist');
    expect(cognito.roleFromGroups(['us-west-1_TestPool1_Google', 'caseworker'])).toBe('caseworker');
    expect(cognito.roleFromGroups(['participant', 'participant'])).toBe('participant');
  });

  it('refuses no role group, several role groups, and anything that is not a list of names', () => {
    expect(cognito.roleFromGroups([])).toBeNull();
    expect(cognito.roleFromGroups(undefined)).toBeNull();
    expect(cognito.roleFromGroups('researcher')).toBeNull();
    expect(cognito.roleFromGroups(['admin'])).toBeNull();
    expect(cognito.roleFromGroups(['participant', 'researcher'])).toBeNull();
    expect(cognito.roleFromGroups([{ name: 'researcher' }])).toBeNull();
  });
});

describe('hosted page URLs', () => {
  it('builds the authorize URL with PKCE, state and nonce', () => {
    const url = new URL(cognito.authorizeUrl({ state: 's1', challenge: 'c1', nonce: 'n1' }));
    expect(url.origin + url.pathname).toBe('https://study-test.auth.us-west-1.amazoncognito.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client123',
      redirect_uri: 'https://app.test/api/auth/cognito/callback',
      scope: 'openid',
      state: 's1',
      nonce: 'n1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    });
  });

  it('builds the logout URL back to the login page', () => {
    const url = new URL(cognito.logoutUrl());
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('logout_uri')).toBe('https://app.test/login');
  });
});

describe('exchangeCode', () => {
  it('posts the code and verifier to the token endpoint', async () => {
    const out = await cognito.exchangeCode('code1', 'verifier1');
    expect(out.id_token).toBe('x.y.z');
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].url).toBe('https://study-test.auth.us-west-1.amazoncognito.com/oauth2/token');
    const body = new URLSearchParams(String(tokenRequests[0].init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client123',
      code: 'code1',
      code_verifier: 'verifier1',
      redirect_uri: 'https://app.test/api/auth/cognito/callback',
    });
    // No client secret configured: no Authorization header.
    expect((tokenRequests[0].init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('raises a CognitoError carrying the error code on a refusal', async () => {
    tokenResponse = new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await expect(cognito.exchangeCode('bad', 'v')).rejects.toMatchObject({
      name: 'CognitoError',
      status: 400,
      code: 'invalid_grant',
    });
  });
});
