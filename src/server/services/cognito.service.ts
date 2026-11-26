// Amazon Cognito client (ai-therapist-387): the study's own user pool, in the
// study's AWS account, signs people in. Sign-in happens on Cognito's hosted
// page, so a password never passes through this app at sign-in. This module
// holds what the sign-in flow needs:
//
//  * the hosted-page URLs (authorize, logout) for the pool's domain;
//  * the authorization-code exchange at {domain}/oauth2/token (PKCE);
//  * an RS256 verifier for the ID TOKEN the exchange returns, against the
//    pool's JWKS (no JWT library: node:crypto does RS256);
//  * the app role read from the token's cognito:groups claim.
//
// Without the COGNITO_* variables (local dev, tests, CI) enabled() is false and
// the legacy username/password login keeps working against the local hash.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { USER_ROLES } from '../../shared/roles.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('cognito');

/** e.g. us-west-1_AbCdEf123; the part before the underscore is the region. */
export const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
export const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
/** Set only when the app client was created with a secret. */
export const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET ?? '';
/** The pool's hosted-page origin, e.g. https://study.auth.us-west-1.amazoncognito.com */
export const DOMAIN = (process.env.COGNITO_DOMAIN ?? '').replace(/\/+$/, '');
/** Public origin of this app; the app client's callback is {APP_URL}/api/auth/cognito/callback. */
export const APP_URL = (process.env.APP_URL ?? process.env.CORS_ORIGIN ?? '').replace(/\/+$/, '');

const POOL_ID_RE = /^([a-z]{2}(?:-[a-z]+)+-\d)_[A-Za-z0-9]+$/;
export const REGION = POOL_ID_RE.exec(USER_POOL_ID)?.[1] ?? '';
/** The `iss` of every token the pool signs, and the base of its JWKS URL. */
export const ISSUER = REGION ? `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}` : '';

const HTTP_TIMEOUT_MS = 10_000;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60_000;
const CLOCK_SKEW_S = 60;

export function enabled(): boolean {
  return Boolean(ISSUER && CLIENT_ID && /^https:\/\//.test(DOMAIN) && APP_URL);
}

export function redirectUri(): string {
  return `${APP_URL}/api/auth/cognito/callback`;
}

/** Where Cognito sends the browser after it ends its own session. Must be
 *  listed as a sign-out URL on the app client. */
export function signedOutUri(): string {
  return `${APP_URL}/login`;
}

/** A non-2xx answer from Cognito's token endpoint, carrying its error code. */
export class CognitoError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail = '',
  ) {
    super(`cognito ${status} ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'CognitoError';
  }
}

type Json = Record<string, unknown>;

/** The HTTP function; tests swap it. */
export let fetchImpl: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
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
  const detail = String(body.error_description ?? (body.error ? '' : text.slice(0, 200)));
  throw new CognitoError(resp.status, code, detail);
}

/** `openid` for the ID token. `aws.cognito.signin.user.admin` so the access
 *  token of a staff sign-in can enrol an authenticator app for that same user
 *  (cognitoAdmin.service.ts); the token stays on the server and is dropped
 *  when it is not needed. The app client must allow both scopes. */
export const SCOPE = 'openid aws.cognito.signin.user.admin';

// ── Hosted page URLs ────────────────────────────────────────────────────────

export function authorizeUrl(p: { state: string; challenge: string; nonce: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${DOMAIN}/oauth2/authorize?${params.toString()}`;
}

/** Ends the hosted page's own session, so the next sign-in asks for
 *  credentials again instead of silently reusing the last account. */
export function logoutUrl(): string {
  const params = new URLSearchParams({ client_id: CLIENT_ID, logout_uri: signedOutUri() });
  return `${DOMAIN}/logout?${params.toString()}`;
}

// ── Authorization code exchange ─────────────────────────────────────────────

export async function exchangeCode(code: string, verifier: string): Promise<Json> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  }
  const resp = await fetchImpl(`${DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    }).toString(),
  });
  return raiseFor(resp);
}

// ── ID-token verification (RS256 against the pool's JWKS) ───────────────────

export interface CognitoClaims {
  iss: string;
  sub: string;
  aud: string;
  token_use: string;
  nonce?: string;
  /** When the person authenticated at the hosted page (seconds). */
  auth_time?: number;
  'cognito:username'?: string;
  'cognito:groups'?: string[];
  iat: number;
  exp: number;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

let jwks: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

export function _resetJwks(): void {
  jwks = null;
}

async function keyFor(kid: string): Promise<KeyObject | null> {
  const age = jwks ? Date.now() - jwks.fetchedAt : Infinity;
  // Refetch when the cache is old, or for an unknown kid (key rotation), but
  // never more than once a minute for unknown kids.
  if (age > JWKS_TTL_MS || (!jwks?.keys.has(kid) && age > JWKS_MIN_REFETCH_MS)) {
    const resp = await fetchImpl(`${ISSUER}/.well-known/jwks.json`);
    const body = (await raiseFor(resp)) as { keys?: Jwk[] };
    const keys = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (k.kty !== 'RSA' || (k.use && k.use !== 'sig')) continue;
      try {
        keys.set(k.kid, createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: 'jwk' }));
      } catch (err) {
        log.warn({ kid: k.kid, err }, 'bad JWK skipped');
      }
    }
    jwks = { keys, fetchedAt: Date.now() };
  }
  return jwks?.keys.get(kid) ?? null;
}

function b64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Verify a Cognito ID token: signature (RS256, kid from the pool's JWKS),
 *  issuer (this pool), audience (this app client), token_use, lifetime, and
 *  the nonce this sign-in attempt sent. Returns null when anything is off;
 *  the reason is logged, never shown. */
export async function verifyIdToken(
  token: string,
  expectedNonce: string,
  now = Math.floor(Date.now() / 1000),
): Promise<CognitoClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: CognitoClaims;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || !claims || typeof claims !== 'object') return null;
  if (header.alg !== 'RS256' || !header.kid) {
    log.warn({ alg: header.alg }, 'token with unexpected alg');
    return null;
  }
  const key = await keyFor(header.kid);
  if (!key) {
    log.warn({ kid: header.kid }, 'token signed by unknown key');
    return null;
  }
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, b64url(parts[2]));
  if (!ok) {
    log.warn('token signature failed');
    return null;
  }
  if (claims.iss !== ISSUER || claims.aud !== CLIENT_ID) {
    log.warn({ iss: claims.iss, aud: claims.aud }, 'token for another pool or app client');
    return null;
  }
  if (claims.token_use !== 'id') {
    log.warn({ token_use: claims.token_use }, 'not an ID token');
    return null;
  }
  if (
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    typeof claims.iat !== 'number' ||
    claims.iat > now + CLOCK_SKEW_S
  ) {
    log.warn({ exp: claims.exp, iat: claims.iat }, 'token outside its lifetime');
    return null;
  }
  if (!expectedNonce || claims.nonce !== expectedNonce) {
    log.warn('token nonce does not match this sign-in attempt');
    return null;
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return claims;
}

/** The app role an account holds in the pool: the one group named after an
 *  app role. No role group, or more than one, is null: the account is refused
 *  rather than given a guessed role. Groups that are not app roles are ignored. */
export function roleFromGroups(groups: unknown): string | null {
  if (!Array.isArray(groups)) return null;
  const roles = [...new Set(groups.filter((g): g is string => typeof g === 'string'))].filter((g) =>
    (USER_ROLES as readonly string[]).includes(g),
  );
  return roles.length === 1 ? roles[0] : null;
}
