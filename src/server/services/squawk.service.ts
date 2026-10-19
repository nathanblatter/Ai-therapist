// Squawk client (auth-service-33): Nathan's auth service signs AI Therapist
// users in. The app is registered there as a user-pool service with the
// password method (existing bcrypt hashes were imported as they are), plus
// passkeys and the owner passkey. This module holds everything that talks to
// Squawk:
//
//  * a cached SERVICE TOKEN (client_credentials with the service credential)
//    that authenticates our backend when it drives the login ceremonies for
//    the login page and manages accounts;
//  * thin helpers for /v1/login/{password,passkey,owner}/* and /v1/users*;
//  * the authorization-code exchange at /oauth/token;
//  * an ES256 verifier for the USER ACCESS TOKEN the exchange returns, against
//    Squawk's JWKS (no JWT library: node:crypto does ES256 with ieee-p1363
//    signatures).
//
// Without SQUAWK_ISSUER (local dev, tests) enabled() is false and the legacy
// username/password login keeps working against the local bcrypt column.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('squawk');

export const ISSUER = (process.env.SQUAWK_ISSUER ?? '').replace(/\/+$/, '');
export const SERVICE_ID = process.env.SQUAWK_SERVICE_ID ?? '';
export const CREDENTIAL = process.env.SQUAWK_CREDENTIAL ?? '';
export const CLIENT_ID = process.env.SQUAWK_CLIENT_ID ?? '';
export const RESOURCE = process.env.SQUAWK_RESOURCE ?? '';
/** The username of the local account Nathan's owner passkey signs in as. */
export const OWNER_USERNAME = process.env.SQUAWK_OWNER_USERNAME ?? '';
/** Public origin of this app; the OAuth client's redirect_uri is {APP_URL}/api/auth/squawk/callback. */
export const APP_URL = (process.env.APP_URL ?? process.env.CORS_ORIGIN ?? '').replace(/\/+$/, '');

export const OWNER_SUBJECT = 'owner';
/** Scopes the login requests: one role:<name> per app role. The token's scope
 *  is the intersection with the user's Squawk roles, which is how the app
 *  reads the role Squawk holds for them. */
export const ROLE_SCOPES = ['role:therapist', 'role:researcher', 'role:participant', 'role:demo', 'role:caseworker'] as const;

const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_S = 30;
const JWKS_TTL_MS = 10 * 60 * 1000;

export function enabled(): boolean {
  return Boolean(ISSUER && SERVICE_ID && CREDENTIAL && CLIENT_ID && RESOURCE);
}

export function redirectUri(): string {
  return `${APP_URL}/api/auth/squawk/callback`;
}

/** A non-2xx answer from Squawk, carrying its error code so a route can map
 *  it to a clean response for the login page. */
export class SquawkError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail = '',
    public readonly retryAfter: number | null = null,
  ) {
    super(`squawk ${status} ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'SquawkError';
  }
}

type Json = Record<string, unknown>;

/** The HTTP function; tests swap it. */
export let fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
export function _setFetch(f: typeof fetch): void {
  fetchImpl = f;
}

async function raiseFor(resp: Response): Promise<Json> {
  const text = await resp.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = {};
  }
  if (resp.ok) return body;
  const code = String(body.error ?? 'server_error');
  const detail = String(body.detail ?? body.error_description ?? (body.error ? '' : text.slice(0, 200)));
  const ra = resp.headers.get('Retry-After');
  throw new SquawkError(resp.status, code, detail, ra && /^\d+$/.test(ra) ? Number(ra) : null);
}

// ── Service token ───────────────────────────────────────────────────────────

let serviceTok: string | null = null;
let serviceTokExp = 0;

export function _resetServiceToken(): void {
  serviceTok = null;
  serviceTokExp = 0;
}

export async function serviceToken(): Promise<string> {
  if (serviceTok && Date.now() / 1000 < serviceTokExp - TOKEN_REFRESH_MARGIN_S) return serviceTok;
  const resp = await fetchImpl(`${ISSUER}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SERVICE_ID, client_secret: CREDENTIAL }).toString(),
  });
  const body = await raiseFor(resp);
  serviceTok = String(body.access_token);
  serviceTokExp = Date.now() / 1000 + Number(body.expires_in ?? 900);
  return serviceTok;
}

async function call<T = Json>(method: string, path: string, json?: unknown, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${ISSUER}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const send = async () => {
    const token = await serviceToken();
    return fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  };
  let resp = await send();
  if (resp.status === 401) {
    // Only OUR token being refused (invalid_token) earns a re-mint and one
    // retry; a 401 that belongs to the ceremony (password_rejected) is the answer.
    let code = '';
    try {
      code = String(((await resp.clone().json()) as Json).error ?? '');
    } catch {
      code = '';
    }
    if (code === 'invalid_token') {
      _resetServiceToken();
      resp = await send();
    }
  }
  return (await raiseFor(resp)) as unknown as T;
}

// ── Login ceremonies (driven for the login page) ────────────────────────────

export interface LoginResult {
  redirect_to: string;
  user?: Json;
}

export function loginPassword(loginChallenge: string, username: string, password: string): Promise<LoginResult> {
  return call<LoginResult>('POST', '/v1/login/password', { login_challenge: loginChallenge, username, password });
}

export function loginPasskeyBegin(loginChallenge: string): Promise<Json> {
  return call('POST', '/v1/login/passkey/begin', { login_challenge: loginChallenge });
}

export function loginPasskeyFinish(challengeId: string, credential: unknown): Promise<LoginResult> {
  return call<LoginResult>('POST', '/v1/login/passkey/finish', credential, { challenge: challengeId });
}

export function loginOwnerBegin(loginChallenge: string): Promise<Json> {
  return call('POST', '/v1/login/owner/begin', { login_challenge: loginChallenge });
}

export function loginOwnerFinish(challengeId: string, credential: unknown): Promise<LoginResult> {
  return call<LoginResult>('POST', '/v1/login/owner/finish', credential, { challenge: challengeId });
}

// ── Accounts (the product manages its users under the service token) ────────

export interface SquawkUser {
  id: string;
  method: string;
  username?: string;
  roles: string[];
  status: string;
}

export function createPasswordUser(username: string, password: string, role: string, name?: string): Promise<SquawkUser> {
  return call<SquawkUser>('POST', '/v1/users', { method: 'password', username, password, roles: [role], name });
}

export function setPassword(squawkUserId: string, password: string): Promise<SquawkUser> {
  return call<SquawkUser>('POST', `/v1/users/${encodeURIComponent(squawkUserId)}/password`, { password });
}

export function setRole(squawkUserId: string, role: string): Promise<SquawkUser> {
  return call<SquawkUser>('PATCH', `/v1/users/${encodeURIComponent(squawkUserId)}`, { roles: [role] });
}

export function deleteUser(squawkUserId: string): Promise<Json> {
  return call('DELETE', `/v1/users/${encodeURIComponent(squawkUserId)}`);
}

export function passkeyRegisterBegin(squawkUserId: string): Promise<Json> {
  return call('POST', `/v1/users/${encodeURIComponent(squawkUserId)}/passkeys/begin`);
}

export function passkeyRegisterFinish(squawkUserId: string, challengeId: string, name: string, credential: unknown): Promise<Json> {
  return call('POST', `/v1/users/${encodeURIComponent(squawkUserId)}/passkeys/finish`, credential, { challenge: challengeId, name });
}

export function listPasskeys(squawkUserId: string): Promise<Json> {
  return call('GET', `/v1/users/${encodeURIComponent(squawkUserId)}/passkeys`);
}

// ── Authorization code exchange ─────────────────────────────────────────────

export async function exchangeCode(code: string, verifier: string): Promise<Json> {
  const resp = await fetchImpl(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri(),
    }).toString(),
  });
  return raiseFor(resp);
}

// ── Access-token verification (ES256 against Squawk's JWKS) ─────────────────

export interface SquawkClaims {
  iss: string;
  sub: string;
  aud: string;
  scope?: string;
  email?: string;
  preferred_username?: string;
  org?: string;
  org_role?: string;
  iat: number;
  exp: number;
  jti?: string;
}

interface Jwk { kid: string; kty: string; crv: string; x: string; y: string; alg?: string; use?: string }

let jwks: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

export function _resetJwks(): void {
  jwks = null;
}

async function keyFor(kid: string): Promise<KeyObject | null> {
  const stale = !jwks || Date.now() - jwks.fetchedAt > JWKS_TTL_MS;
  if (stale || !jwks?.keys.has(kid)) {
    // Unknown kid: refetch once (key rotation), but never more than once a minute.
    if (!jwks || Date.now() - jwks.fetchedAt > 60_000 || stale) {
      const resp = await fetchImpl(`${ISSUER}/.well-known/jwks.json`);
      const body = (await raiseFor(resp)) as { keys?: Jwk[] };
      const keys = new Map<string, KeyObject>();
      for (const k of body.keys ?? []) {
        if (k.kty !== 'EC' || k.crv !== 'P-256') continue;
        try {
          keys.set(k.kid, createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, format: 'jwk' }));
        } catch (err) {
          log.warn({ kid: k.kid, err }, 'bad JWK skipped');
        }
      }
      jwks = { keys, fetchedAt: Date.now() };
    }
  }
  return jwks?.keys.get(kid) ?? null;
}

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Verify a Squawk user access token: signature (ES256, kid from the JWKS),
 *  issuer, audience (= our service id), and lifetime. Returns null when
 *  anything is off; the reason is logged, never shown. */
export async function verifyAccessToken(token: string, now = Math.floor(Date.now() / 1000)): Promise<SquawkClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: SquawkClaims;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'ES256' || !header.kid) {
    log.warn({ alg: header.alg }, 'token with unexpected alg');
    return null;
  }
  const key = await keyFor(header.kid);
  if (!key) {
    log.warn({ kid: header.kid }, 'token signed by unknown key');
    return null;
  }
  const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, b64url(parts[2]));
  if (!ok) {
    log.warn('token signature failed');
    return null;
  }
  if (claims.iss !== ISSUER || claims.aud !== SERVICE_ID) {
    log.warn({ iss: claims.iss, aud: claims.aud }, 'token for another issuer or service');
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + 60) {
    log.warn({ exp: claims.exp, iat: claims.iat }, 'token outside its lifetime');
    return null;
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return claims;
}

/** The app role carried in a token's scope (role:<name>), or null. */
export function roleFromScope(scope: string | undefined): string | null {
  for (const s of (scope ?? '').split(/\s+/)) {
    if (s.startsWith('role:')) return s.slice('role:'.length);
  }
  return null;
}
