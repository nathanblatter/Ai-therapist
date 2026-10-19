// Sign-in through Squawk (auth-service-33).
//
//   GET  /api/auth/squawk/config      {enabled}
//   GET  /api/auth/squawk/start       302 → Squawk /oauth/authorize (PKCE); Squawk parks the
//                                     request and sends the browser to /login?login_challenge=
//   POST /api/auth/squawk/password    {login_challenge, username, password} → {redirect_to}
//   POST /api/auth/squawk/passkey/begin|finish, /owner/begin|finish   (WebAuthn proxies)
//   GET  /api/auth/squawk/callback    ?code&state → exchange, verify, establish the session
//   POST /api/auth/squawk/passkeys/begin|finish   signed-in user registers a passkey
//   GET  /api/auth/squawk/passkeys    signed-in user's passkeys
//
// The app keeps its express session exactly as before: the callback stamps the
// same fields the legacy login did, after regenerating the session id.
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { requireAuth } from '../../middleware/auth.js';
import { getUserById, getUserBySquawkId, getUserByUsernameForLogin, setSquawkUserId, syncRoleFromSquawk, type UserRow } from '../../db/index.js';
import { USER_ROLES } from '../../../shared/roles.js';
import * as squawk from '../../services/squawk.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('squawkAuth');

const LOGIN_PAGE = '/login';
const STATE_TTL_MS = 5 * 60 * 1000;

const ERROR_MESSAGES: Record<string, string> = {
  password_rejected: 'Invalid username or password',
  passkey_rejected: 'Passkey not recognized.',
  setup_required: 'No owner passkey is registered in Squawk yet.',
  account_disabled: 'That account is disabled.',
  email_unverified: 'That account has not verified its email.',
  too_many_attempts: 'Too many attempts. Try again later.',
  not_found: 'This sign-in attempt expired. Start over.',
  invalid_request: 'That account does not sign in this way.',
};

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

/** Map a Squawk refusal to the login page's response. */
function sendSquawkError(res: Response, err: unknown): void {
  if (err instanceof squawk.SquawkError) {
    const status = [400, 401, 403, 404, 409, 429].includes(err.status) ? err.status : 502;
    if (err.status === 429 && err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    const message = status === 502 ? 'Sign-in service unavailable. Try again.' : (ERROR_MESSAGES[err.code] ?? err.detail ?? 'Sign-in failed.');
    if (status === 502) log.warn({ err: err.message }, 'Squawk upstream error');
    res.status(status).json({ error: message, code: err.code });
    return;
  }
  log.error({ err }, 'Squawk request error');
  res.status(502).json({ error: 'Sign-in service unavailable. Try again.', code: 'server_error' });
}

function requireSquawk(_req: Request, res: Response, next: () => void): void {
  if (!squawk.enabled()) {
    res.status(404).json({ error: 'Squawk sign-in is not configured', code: 'not_configured' });
    return;
  }
  next();
}

/** Resolve the local account for verified Squawk claims: the owner maps to
 *  the configured researcher account; a user maps by stored Squawk id, or on
 *  the first login by username (and is linked for next time). */
export async function resolveLocalUser(claims: squawk.SquawkClaims): Promise<UserRow | null> {
  if (claims.sub === squawk.OWNER_SUBJECT) {
    if (!squawk.OWNER_USERNAME) {
      log.warn('owner signed in but SQUAWK_OWNER_USERNAME is unset');
      return null;
    }
    return getUserByUsernameForLogin(squawk.OWNER_USERNAME);
  }
  const squawkId = claims.sub.startsWith('usr:') ? claims.sub.slice(4) : null;
  if (!squawkId) return null;
  let user = await getUserBySquawkId(squawkId);
  if (!user && claims.preferred_username) {
    user = await getUserByUsernameForLogin(claims.preferred_username);
    if (user && !user.squawk_user_id) {
      await setSquawkUserId(user.userid, squawkId);
      user = { ...user, squawk_user_id: squawkId };
    } else if (user) {
      log.warn({ username: user.username }, 'username matches a row linked to another Squawk id');
      return null;
    }
  }
  if (!user) return null;
  // Squawk is the source of roles: copy what the token says, if it is a role we know.
  const role = squawk.roleFromScope(claims.scope);
  if (role && (USER_ROLES as readonly string[]).includes(role) && role !== user.role) {
    await syncRoleFromSquawk(user.userid, role);
    user = { ...user, role };
  }
  return user;
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

export default function squawkAuthRoutes(): Router {
  const router = Router();

  const ceremonyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please try again in a few minutes.', code: 'too_many_attempts' },
  });

  router.get('/api/auth/squawk/config', (_req, res) => {
    res.json({ enabled: squawk.enabled(), owner: Boolean(squawk.OWNER_USERNAME) });
  });

  // Start: stash PKCE + state on the session, send the browser to Squawk.
  router.get('/api/auth/squawk/start', requireSquawk, (req, res) => {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(24).toString('base64url');
    req.session.squawkAuth = { state, verifier, startedAt: Date.now() };
    req.session.save((err) => {
      if (err) {
        log.error({ err }, 'session save before Squawk start failed');
        return loginError(res, 'server_error');
      }
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: squawk.CLIENT_ID,
        redirect_uri: squawk.redirectUri(),
        state,
        resource: squawk.RESOURCE,
        scope: squawk.ROLE_SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      res.redirect(302, `${squawk.ISSUER}/oauth/authorize?${params.toString()}`);
    });
  });

  // Callback: exchange the code, verify the token, map to the local account.
  router.get('/api/auth/squawk/callback', requireSquawk, async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return loginError(res, error);
    const stashed = req.session.squawkAuth;
    delete req.session.squawkAuth;
    if (!code || !state || !stashed || stashed.state !== state || Date.now() - stashed.startedAt > STATE_TTL_MS) {
      return loginError(res, 'state_mismatch');
    }
    let claims: squawk.SquawkClaims | null;
    try {
      const tokens = await squawk.exchangeCode(code, stashed.verifier);
      claims = await squawk.verifyAccessToken(String(tokens.access_token ?? ''));
    } catch (err) {
      if (err instanceof squawk.SquawkError) {
        log.warn({ err: err.message }, 'Squawk code exchange failed');
        return loginError(res, err.code);
      }
      log.error({ err }, 'Squawk code exchange error');
      return loginError(res, 'server_error');
    }
    if (!claims) return loginError(res, 'invalid_token');
    let user: UserRow | null;
    try {
      user = await resolveLocalUser(claims);
    } catch (err) {
      log.error({ err }, 'local account lookup failed');
      return loginError(res, 'server_error');
    }
    if (!user) {
      log.warn({ sub: claims.sub, username: claims.preferred_username }, 'Squawk login has no local account');
      return loginError(res, claims.sub === squawk.OWNER_SUBJECT ? 'owner_not_mapped' : 'no_account');
    }
    try {
      await establishSession(req, user);
    } catch (err) {
      log.error({ err }, 'session establish failed');
      return loginError(res, 'server_error');
    }
    log.info({ userid: user.userid, role: user.role, sub: claims.sub }, 'signed in via Squawk');
    res.redirect(302, destinationFor(user.role));
  });

  // Ceremony proxies for the login page.
  router.post('/api/auth/squawk/password', requireSquawk, ceremonyLimiter, async (req, res) => {
    const { login_challenge, username, password } = req.body ?? {};
    if (typeof login_challenge !== 'string' || typeof username !== 'string' || typeof password !== 'string' || !login_challenge || !username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    try {
      const out = await squawk.loginPassword(login_challenge, username.trim(), password);
      res.json({ redirect_to: out.redirect_to });
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  router.post('/api/auth/squawk/passkey/begin', requireSquawk, ceremonyLimiter, async (req, res) => {
    const { login_challenge } = req.body ?? {};
    if (typeof login_challenge !== 'string' || !login_challenge) return res.status(400).json({ error: 'login_challenge is required' });
    try {
      res.json(await squawk.loginPasskeyBegin(login_challenge));
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  router.post('/api/auth/squawk/passkey/finish', requireSquawk, ceremonyLimiter, async (req, res) => {
    const { challenge_id, credential } = req.body ?? {};
    if (typeof challenge_id !== 'string' || !challenge_id || !credential) return res.status(400).json({ error: 'challenge_id and credential are required' });
    try {
      const out = await squawk.loginPasskeyFinish(challenge_id, credential);
      res.json({ redirect_to: out.redirect_to });
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  router.post('/api/auth/squawk/owner/begin', requireSquawk, ceremonyLimiter, async (req, res) => {
    const { login_challenge } = req.body ?? {};
    if (typeof login_challenge !== 'string' || !login_challenge) return res.status(400).json({ error: 'login_challenge is required' });
    try {
      res.json(await squawk.loginOwnerBegin(login_challenge));
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  router.post('/api/auth/squawk/owner/finish', requireSquawk, ceremonyLimiter, async (req, res) => {
    const { challenge_id, credential } = req.body ?? {};
    if (typeof challenge_id !== 'string' || !challenge_id || !credential) return res.status(400).json({ error: 'challenge_id and credential are required' });
    try {
      const out = await squawk.loginOwnerFinish(challenge_id, credential);
      res.json({ redirect_to: out.redirect_to });
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  // Passkeys for the signed-in account (registering one converts a password
  // account: Squawk drops the hash, so the next sign-in is passkey-only).
  const linkedId = async (req: Request): Promise<string | null> => {
    const user = await getUserById(req.session.userId!);
    return user?.squawk_user_id ?? null;
  };

  router.get('/api/auth/squawk/passkeys', requireSquawk, requireAuth, async (req, res) => {
    try {
      const id = await linkedId(req);
      if (!id) return res.json({ linked: false, passkeys: [] });
      const out = await squawk.listPasskeys(id);
      res.json({ linked: true, passkeys: out.passkeys ?? [] });
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  router.post('/api/auth/squawk/passkeys/begin', requireSquawk, requireAuth, async (req, res) => {
    try {
      const id = await linkedId(req);
      if (!id) return res.status(409).json({ error: 'This account is not linked to Squawk yet; sign out and back in first.', code: 'not_linked' });
      res.json(await squawk.passkeyRegisterBegin(id));
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  router.post('/api/auth/squawk/passkeys/finish', requireSquawk, requireAuth, async (req, res) => {
    const { challenge_id, name, credential } = req.body ?? {};
    if (typeof challenge_id !== 'string' || !challenge_id || !credential) return res.status(400).json({ error: 'challenge_id and credential are required' });
    try {
      const id = await linkedId(req);
      if (!id) return res.status(409).json({ error: 'This account is not linked to Squawk yet.', code: 'not_linked' });
      res.status(201).json(await squawk.passkeyRegisterFinish(id, challenge_id, typeof name === 'string' ? name.slice(0, 60) : 'Passkey', credential));
    } catch (err) {
      sendSquawkError(res, err);
    }
  });

  return router;
}
