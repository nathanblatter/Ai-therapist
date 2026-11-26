// Sign-in through Amazon Cognito (ai-therapist-387).
//
//   GET /api/auth/cognito/config     {enabled}
//   GET /api/auth/cognito/start      302 → the pool's hosted sign-in page (PKCE, state, nonce)
//   GET /api/auth/cognito/callback   ?code&state → exchange, verify, establish the session
//
// Staff must sign in with an authenticator-app code (ai-therapist-396). The
// pool cannot require one for some roles only, and its hosted page does not
// offer to set one up while it is optional, so this app does both: a staff
// sign-in whose pool account has no authenticator gets no app session, only a
// short-lived enrolment state, and these finish it:
//
//   GET  /api/auth/cognito/totp/status   {pending, username?}
//   POST /api/auth/cognito/totp/begin    {secret, qrCode}
//   POST /api/auth/cognito/totp/verify   {code} → switches the challenge on, establishes the session
//
// Sign-out stays POST /api/auth/logout (auth.routes.ts), which with Cognito
// configured also returns the hosted page's logout URL for the browser to visit.
//
// The app keeps its express session exactly as before: the callback stamps the
// same fields the legacy login did, after regenerating the session id. The
// password is typed on Cognito's page and never reaches this app.
import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
  getUserByCognitoSub,
  getUserById,
  getUserByUsernameForCognito,
  setCognitoSub,
  syncRoleFromCognito,
  type UserRow,
} from '../../db/index.js';
import * as cognito from '../../services/cognito.service.js';
import * as cognitoAdmin from '../../services/cognitoAdmin.service.js';
import { generateQRCode } from '../../services/mfa.service.js';
import { requiresSecondFactor } from '../../../shared/roles.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cognitoAuth');

const LOGIN_PAGE = '/login';
const STATE_TTL_MS = 10 * 60 * 1000;
/** How long a staff member has to finish enrolling an authenticator app. Well
 *  inside the access token's 60 minutes. */
const ENROL_TTL_MS = 15 * 60 * 1000;
const ENROL_MAX_ATTEMPTS = 8;
const ENROL_PAGE = `${LOGIN_PAGE}?enrol=totp`;

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

/** Replace whatever the browser session held with the enrolment state alone.
 *  Nothing that marks a signed-in session (userId, userRole) is set. */
function establishEnrolment(req: Request, user: UserRow, accessToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenErr) => {
      if (regenErr) return reject(regenErr);
      req.session.cognitoEnrol = {
        userId: user.userid,
        username: user.username,
        accessToken,
        startedAt: Date.now(),
        attempts: 0,
      };
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
  });
}

function pendingEnrolment(req: Request): NonNullable<Request['session']['cognitoEnrol']> | null {
  const e = req.session.cognitoEnrol;
  if (!e) return null;
  if (Date.now() - e.startedAt > ENROL_TTL_MS || e.attempts >= ENROL_MAX_ATTEMPTS) {
    delete req.session.cognitoEnrol;
    return null;
  }
  return e;
}

/** The label an authenticator app shows for the account. */
function otpauthUrl(username: string, secret: string): string {
  const issuer = 'AI Therapist';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}`;
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
    let accessToken = '';
    try {
      const tokens = await cognito.exchangeCode(code, stashed.verifier);
      claims = await cognito.verifyIdToken(String(tokens.id_token ?? ''), stashed.nonce);
      accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
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
    if (requiresSecondFactor(user.role)) {
      // The pool asks for a code at every sign-in once an authenticator is
      // switched on for the account, so "switched on" means this sign-in used
      // one. If the pool cannot be asked, the sign-in is refused: never let
      // staff in on a password alone because a lookup failed.
      let enrolled: boolean;
      try {
        enrolled = await cognitoAdmin.getTotpEnabled(user.username);
      } catch (err) {
        log.error({ err, userid: user.userid }, 'could not read the authenticator state of a staff account');
        return loginError(res, 'server_error');
      }
      if (!enrolled) {
        if (!accessToken) {
          log.error({ userid: user.userid }, 'staff sign-in without an authenticator returned no access token');
          return loginError(res, 'server_error');
        }
        try {
          await establishEnrolment(req, user, accessToken);
        } catch (err) {
          log.error({ err }, 'enrolment session establish failed');
          return loginError(res, 'server_error');
        }
        log.info({ userid: user.userid, role: user.role }, 'staff sign-in held for authenticator enrolment');
        return res.redirect(302, ENROL_PAGE);
      }
    }
    try {
      await establishSession(req, user);
    } catch (err) {
      log.error({ err }, 'session establish failed');
      return loginError(res, 'server_error');
    }
    log.info({ userid: user.userid, role: user.role }, 'signed in via Cognito');
    res.redirect(302, destinationFor(user.role));
  });

  // ── Authenticator enrolment for staff ─────────────────────────────────────

  router.get('/api/auth/cognito/totp/status', requireCognito, (req, res) => {
    const pending = pendingEnrolment(req);
    res.json(pending ? { pending: true, username: pending.username } : { pending: false });
  });

  router.post('/api/auth/cognito/totp/begin', requireCognito, async (req, res) => {
    const pending = pendingEnrolment(req);
    if (!pending)
      return res.status(401).json({ error: 'Sign in again to set up your authenticator app.', code: 'enrol_expired' });
    try {
      const { secret } = await cognitoAdmin.beginTotpEnrolment(pending.accessToken);
      const qrCode = await generateQRCode(otpauthUrl(pending.username, secret));
      res.json({ secret, qrCode });
    } catch (err) {
      log.error({ err, userid: pending.userId }, 'authenticator enrolment could not start');
      res.status(502).json({ error: 'The sign-in service could not start the setup. Sign in again.' });
    }
  });

  router.post('/api/auth/cognito/totp/verify', requireCognito, async (req, res) => {
    const pending = pendingEnrolment(req);
    if (!pending)
      return res.status(401).json({ error: 'Sign in again to set up your authenticator app.', code: 'enrol_expired' });
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    pending.attempts += 1;
    try {
      if (!(await cognitoAdmin.verifyTotpEnrolment(pending.accessToken, code))) {
        return res
          .status(401)
          .json({ error: 'That code did not match. Check the app and try again.', code: 'code_mismatch' });
      }
      await cognitoAdmin.setTotpEnabled(pending.username, true);
    } catch (err) {
      log.error({ err, userid: pending.userId }, 'authenticator enrolment failed');
      return res.status(502).json({ error: 'The sign-in service could not finish the setup. Sign in again.' });
    }
    // The code just proved the second factor for this sign-in. Read the row
    // again: the account may have been changed or removed in the meantime.
    try {
      const user = await getUserById(pending.userId);
      if (!user || user.username !== pending.username || !requiresSecondFactor(user.role)) {
        delete req.session.cognitoEnrol;
        return res.status(401).json({ error: 'Sign in again.', code: 'enrol_expired' });
      }
      await establishSession(req, user);
      log.info({ userid: user.userid, role: user.role }, 'authenticator enrolled; signed in via Cognito');
      res.json({ success: true, redirect: destinationFor(user.role) });
    } catch (err) {
      log.error({ err, userid: pending.userId }, 'session establish after enrolment failed');
      res.status(500).json({ error: 'Setup finished, but sign-in did not. Sign in again.' });
    }
  });

  return router;
}
