// Squawk token verification (auth-service-33): ES256 against a JWKS, issuer,
// audience and lifetime checks, with the HTTP layer swapped for a stub.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

vi.stubEnv('SQUAWK_ISSUER', 'https://squawk.test');
vi.stubEnv('SQUAWK_SERVICE_ID', 'svc_test');
vi.stubEnv('SQUAWK_CREDENTIAL', 'nbc_cred');
vi.stubEnv('SQUAWK_CLIENT_ID', 'nbc_client');
vi.stubEnv('SQUAWK_RESOURCE', 'https://app.test/api');

const squawk = await import('./squawk.service.js');

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(claims: Record<string, unknown>, kid = 'k1', alg = 'ES256'): string {
  const signingInput = `${b64({ alg, typ: 'JWT', kid })}.${b64(claims)}`;
  const sig = cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${sig.toString('base64url')}`;
}

const now = 1_800_000_000;
const good = {
  iss: 'https://squawk.test',
  sub: 'usr:abc',
  aud: 'svc_test',
  scope: 'role:participant',
  preferred_username: 'p0042',
  iat: now - 5,
  exp: now + 3600,
  jti: 'j1',
};

let jwksCalls = 0;
beforeEach(() => {
  jwksCalls = 0;
  squawk._resetJwks();
  squawk._setFetch((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/.well-known/jwks.json')) {
      jwksCalls++;
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  }) as typeof fetch);
});

describe('verifyAccessToken', () => {
  it('accepts a token signed by a JWKS key for this service', async () => {
    const claims = await squawk.verifyAccessToken(mint(good), now);
    expect(claims?.sub).toBe('usr:abc');
    expect(claims?.preferred_username).toBe('p0042');
    // The JWKS is cached across verifications.
    await squawk.verifyAccessToken(mint(good), now);
    expect(jwksCalls).toBe(1);
  });

  it('rejects a bad signature, another issuer or audience, and an expired token', async () => {
    const tampered = mint(good).replace(/\.[^.]+$/, '.AAAA');
    expect(await squawk.verifyAccessToken(tampered, now)).toBeNull();
    expect(await squawk.verifyAccessToken(mint({ ...good, iss: 'https://evil.test' }), now)).toBeNull();
    expect(await squawk.verifyAccessToken(mint({ ...good, aud: 'svc_other' }), now)).toBeNull();
    expect(await squawk.verifyAccessToken(mint({ ...good, exp: now - 1 }), now)).toBeNull();
    expect(await squawk.verifyAccessToken(mint(good, 'k1', 'HS256'), now)).toBeNull();
    expect(await squawk.verifyAccessToken('not.a.jwt', now)).toBeNull();
  });

  it('rejects a token signed by a key the JWKS does not list', async () => {
    expect(await squawk.verifyAccessToken(mint(good, 'k2'), now)).toBeNull();
  });
});

describe('roleFromScope', () => {
  it('reads the app role out of the token scope', () => {
    expect(squawk.roleFromScope('role:therapist')).toBe('therapist');
    expect(squawk.roleFromScope('read role:caseworker write')).toBe('caseworker');
    expect(squawk.roleFromScope('read')).toBeNull();
    expect(squawk.roleFromScope(undefined)).toBeNull();
  });
});

describe('service token and errors', () => {
  it('mints a service token once and maps Squawk refusals to SquawkError', async () => {
    let tokenCalls = 0;
    squawk._resetServiceToken();
    squawk._setFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/token')) {
        tokenCalls++;
        expect(String(init?.body)).toContain('grant_type=client_credentials');
        return new Response(JSON.stringify({ access_token: 'svc-tok', expires_in: 900 }), { status: 200 });
      }
      if (url.includes('/v1/login/password')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer svc-tok');
        return new Response(JSON.stringify({ error: 'password_rejected', detail: 'wrong username or password' }), {
          status: 401,
        });
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch);
    await expect(squawk.loginPassword('lc', 'p0042', 'nope')).rejects.toMatchObject({
      name: 'SquawkError',
      status: 401,
      code: 'password_rejected',
    });
    await expect(squawk.loginPassword('lc', 'p0042', 'nope')).rejects.toBeInstanceOf(squawk.SquawkError);
    expect(tokenCalls).toBe(1);
  });

  it('re-mints the service token once when Squawk says it is invalid', async () => {
    let tokenCalls = 0;
    let calls = 0;
    squawk._resetServiceToken();
    squawk._setFetch((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/token')) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: `svc-tok-${tokenCalls}`, expires_in: 900 }), {
          status: 200,
        });
      }
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
      return new Response(JSON.stringify({ passkeys: [] }), { status: 200 });
    }) as typeof fetch);
    await expect(squawk.listPasskeys('usr_x')).resolves.toEqual({ passkeys: [] });
    expect(tokenCalls).toBe(2);
    expect(calls).toBe(2);
  });
});
