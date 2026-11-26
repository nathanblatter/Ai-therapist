// Sign-in through Amazon Cognito (ai-therapist-387).
//
//   GET /api/auth/cognito/config     {enabled}
//   GET /api/auth/cognito/start      302 → the pool's hosted sign-in page (PKCE, state, nonce)
//   GET /api/auth/cognito/callback   ?code&state → exchange, verify, establish the session
//   GET /api/auth/cognito/logout     ends the app session, then 302 → Cognito's logout
//
// The app keeps its express session exactly as before: the callback stamps the
// same fields the legacy login did, after regenerating the session id. The
// password is typed on Cognito's page and never reaches this app.
import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
  getUserByCognitoSub,
  getUserByUsernameForCognito,
  setCognitoSub,
  syncRoleFromCognito,
  type UserRow,
} from '../../db/index.js';
import * as cognito from '../../services/cognito.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cognitoAuth');

const LOGIN_PAGE = '/login';
const STATE_TTL_MS = 10 * 60 * 1000;

function destinationFor(role?: string): string {
  return role === 'therapist' || role === 'caseworker' || role === 'researcher' ? '/admin' : '/';
}

function loginError(res: Response, code: string): void {
  res.redirect(302, `${LOGIN_PAGE}?error=${encodeURIComponent(code)}`);
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, within RFC 7636's 43–128
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function requireCognito(_req: Request, res: Response, next: () => void): void {
  if (!cognito.enabled()) {
    res.status(404).json({ error: 'Cognito sign-in is not configured', code: 'not_configured' });
    return;
  }
  next();
}

export type ResolveResult = { user: UserRow } | { error: 'no_role' | 'no_account' };

/** Resolve the local account for verified Cognito claims. The pool holds the
 *  role (exactly one role group, or the sign-in is refused); the local row is
 *  found by the stored Cognito subject, or on the first sign-in by username
 *  (and is linked for next time). The pool has no self-sign-up, so a username
 *  in it was put there by this app or by study staff. */
export async function resolveLocalUser(claims: cognito.CognitoClaims): Promise<ResolveResult> {
  const role = cognito.roleFromGroups(claims['cognito:groups']);
  if (!role) {
    log.warn({ sub: claims.sub, groups: claims['cognito:groups'] }, 'account has no single role group');
    return { error: 'no_role' };
  }
  let user = await getUserByCognitoSub(claims.sub);
  const username = claims['cognito:username'];
  if (!user && username) {
    user = await getUserByUsernameForCognito(username);
    if (user && !user.cognito_sub) {
      await setCognitoSub(user.userid, claims.sub);
      user = { ...user, cognito_sub: claims.sub };
    } else if (user) {
      log.warn({ username: user.username }, 'username matches a row linked to another Cognito subject');
      return { error: 'no_account' };
    }
  }
  if (!user) return { error: 'no_account' };
  if (role !== user.role) {
    await syncRoleFromCognito(user.userid, role);
    user = { ...user, role };
  }
  return { user };
}

/** Establish the app session for a user, the same way the legacy login does:
 *  a fresh session id, browser-scoped state carried over, account fields stamped. */
function establishSession(req: Request, user: UserRow): Promise<void> {
  const carried = {
    ownedSessions: req.session.ownedSessions,
    consentAccepted: req.session.consentAccepted,
    consentVersion: req.session.consentVersion,
    consentAcceptedAt: req.session.consentAcceptedAt,
  };
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenErr) => {
      if (regenErr) return reject(regenErr);
      Object.assign(req.session, carried);
      req.session.userId = user.userid;
      req.session.username = user.username;
      req.session.userRole = user.role;
      req.session.mfaVerified = true;
      if (typeof user.organization_id === 'number') req.session.orgId = user.organization_id;
      req.session.isSandbox = user.is_sandbox === true;
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
  });
}

export default function cognitoAuthRoutes(): Router {
  const router = Router();

  router.get('/api/auth/cognito/config', (_req, res) => {
    res.json({ enabled: cognito.enabled() });
  });

  // Start: stash PKCE verifier, state and nonce on the session, send the
  // browser to the hosted sign-in page.
  router.get('/api/auth/cognito/start', requireCognito, (req, res) => {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    req.session.cognitoAuth = { state, verifier, nonce, startedAt: Date.now() };
    req.session.save((err) => {
      if (err) {
        log.error({ err }, 'session save before Cognito start failed');
        return loginError(res, 'server_error');
      }
      res.redirect(302, cognito.authorizeUrl({ state, challenge, nonce }));
    });
  });

  // Callback: exchange the code, verify the ID token, map to the local account.
  router.get('/api/auth/cognito/callback', requireCognito, async (req, res) => {
    const { code, state, error } = req.query as Record<string, unknown>;
    const stashed = req.session.cognitoAuth;
    delete req.session.cognitoAuth;
    if (typeof error === 'string' && error) {
      log.warn({ error }, 'Cognito returned an error to the callback');
      return loginError(res, 'sign_in_failed');
    }
    if (
      typeof code !== 'string' ||
      typeof state !== 'string' ||
      !code ||
      !state ||
      !stashed ||
      stashed.state !== state ||
      Date.now() - stashed.startedAt > STATE_TTL_MS
    ) {
      return loginError(res, 'state_mismatch');
    }
    let claims: cognito.CognitoClaims | null;
    try {
      const tokens = await cognito.exchangeCode(code, stashed.verifier);
      claims = await cognito.verifyIdToken(String(tokens.id_token ?? ''), stashed.nonce);
    } catch (err) {
      if (err instanceof cognito.CognitoError) {
        log.warn({ err: err.message }, 'Cognito code exchange failed');
        return loginError(res, 'sign_in_failed');
      }
      log.error({ err }, 'Cognito code exchange error');
      return loginError(res, 'server_error');
    }
    if (!claims) return loginError(res, 'invalid_token');
    let resolved: ResolveResult;
    try {
      resolved = await resolveLocalUser(claims);
    } catch (err) {
      log.error({ err }, 'local account lookup failed');
      return loginError(res, 'server_error');
    }
    if ('error' in resolved) {
      log.warn({ sub: claims.sub, username: claims['cognito:username'] }, `Cognito sign-in refused: ${resolved.error}`);
      return loginError(res, resolved.error);
    }
    const { user } = resolved;
    try {
      await establishSession(req, user);
    } catch (err) {
      log.error({ err }, 'session establish failed');
      return loginError(res, 'server_error');
    }
    log.info({ userid: user.userid, role: user.role }, 'signed in via Cognito');
    res.redirect(302, destinationFor(user.role));
  });

  // Sign out of both: the app session first, then the hosted page's own
  // session (otherwise the next "sign in" silently reuses the last account,
  // which matters on a shared lab computer). Not behind requireCognito, so a
  // stale link still signs the browser out of the app.
  router.get('/api/auth/cognito/logout', (req, res) => {
    const next = cognito.enabled() ? cognito.logoutUrl() : LOGIN_PAGE;
    req.session.destroy((err) => {
      if (err) {
        log.error({ err }, 'Logout error');
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.clearCookie('connect.sid');
      res.redirect(302, next);
    });
  });

  return router;
}
