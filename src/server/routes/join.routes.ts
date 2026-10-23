// Public client self-registration via a therapist's one-time invite link
// (ai-therapist-119, caseload RBAC).
//   - GET  /join/:token — minimal self-contained registration page (or a 410
//     page when the invite is unknown, already used, or expired).
//   - POST /join/:token — atomically consumes the invite, creates a
//     participant account, auto-assigns it to the inviting therapist, and
//     establishes the session exactly like login does.
// Plus the sandbox variant (caseworker portal, docs/caseworker-portal.md §7):
//   - GET  /join-sandbox/:token — same page shape with the sandbox disclosure.
//   - POST /join-sandbox/:token — consumes a sandbox invite, creates a fresh
//     per-account kind='sandbox' org + a therapist/caseworker owner account,
//     and synchronously seeds a deterministic synthetic caseload (no LLM
//     calls). Compensating cleanup on any failure.
// The raw token is never reflected into HTML (the page reads it from
// location.pathname) and only its sha256 hash is ever compared in the DB.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  findInviteByToken,
  consumeInvite,
  releaseInvite,
  completeInviteGrant,
  getUserById,
  findSandboxInviteByToken,
  consumeSandboxInvite,
  releaseSandboxInvite,
  markSandboxInviteUsedAudited,
  createOrganization,
  deleteSandboxOrganization,
} from '../db/index.js';
import { seedSandboxCaseload } from '../services/sandboxSeed.js';
import { isCareTeamRole } from '../../shared/roles.js';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from '../utils/passwordPolicy.js';
import {
  MIN_USERNAME_LENGTH,
  MAX_USERNAME_LENGTH,
  USERNAME_HTML_PATTERN,
  usernamePolicyError,
} from '../utils/usernamePolicy.js';
import { registerAccount, removeAccount } from '../services/accounts.service.js';

import { createLogger } from '../utils/logger.js';

const log = createLogger('joinRoutes');

const GONE_MESSAGE = 'This invite link is no longer valid. Ask your therapist for a new one.';
const SANDBOX_GONE_MESSAGE = 'This sandbox link is no longer valid. Ask whoever sent it for a new one.';

interface RegistrationPageOptions {
  title: string;
  intro: string;
  /** Optional amber notice block (sandbox disclosure). Static server copy —
   *  never derived from request input. */
  notice?: string;
  buttonLabel: string;
  /** Where the browser goes after a successful signup. */
  redirectTo: string;
  /** Shown while the server assembles the account (sandbox seeding). */
  busyLabel?: string;
}

function registrationPage(opts: RegistrationPageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 2rem; width: 100%; max-width: 22rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { font-size: 0.875rem; color: #57534e; margin: 0 0 1.25rem; }
  label { display: block; font-size: 0.8125rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem 0.625rem; border: 1px solid #d6d3d1; border-radius: 8px; font-size: 0.9375rem; }
  button { width: 100%; margin-top: 1.25rem; padding: 0.625rem; border: 0; border-radius: 8px; background: #1c1917; color: #fff; font-size: 0.9375rem; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { display: none; margin-top: 0.75rem; font-size: 0.8125rem; color: #b91c1c; }
  .notice { margin: 0 0 1.25rem; padding: 0.625rem 0.75rem; border: 1px solid #fcd34d; background: #fffbeb; color: #92400e; border-radius: 8px; font-size: 0.8125rem; }
</style>
</head>
<body>
<div class="card">
  <h1>${opts.title}</h1>
  <p>${opts.intro}</p>
  ${opts.notice ? `<div class="notice">${opts.notice}</div>` : ''}
  <form id="join-form">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required minlength="${MIN_USERNAME_LENGTH}" maxlength="${MAX_USERNAME_LENGTH}" pattern="${USERNAME_HTML_PATTERN}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}">
    <button type="submit" id="submit-btn">${opts.buttonLabel}</button>
    <div class="error" id="error"></div>
  </form>
</div>
<script>
  const form = document.getElementById('join-form');
  const errorEl = document.getElementById('error');
  const btn = document.getElementById('submit-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    btn.disabled = true;
    ${opts.busyLabel ? `btn.textContent = ${JSON.stringify(opts.busyLabel)};` : ''}
    try {
      const res = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        location.href = ${JSON.stringify(opts.redirectTo)};
        return;
      }
      errorEl.textContent = data.error || 'Registration failed. Please try again.';
      errorEl.style.display = 'block';
    } catch (err) {
      errorEl.textContent = 'Network error. Please try again.';
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      ${opts.busyLabel ? `btn.textContent = ${JSON.stringify(opts.buttonLabel)};` : ''}
    }
  });
</script>
</body>
</html>`;
}

function gonePage(hint = 'Ask your therapist for a new one.'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Invite link expired</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 2rem; width: 100%; max-width: 22rem; text-align: center; }
  h1 { font-size: 1.125rem; margin: 0 0 0.5rem; }
  p { font-size: 0.875rem; color: #57534e; margin: 0; }
</style>
</head>
<body>
<div class="card">
  <h1>This invite link is no longer valid</h1>
  <p>It may have expired or already been used. ${hint}</p>
</div>
</body>
</html>`;
}

const CLIENT_PAGE_OPTIONS: RegistrationPageOptions = {
  title: 'Create your account',
  intro: 'Your therapist invited you to this platform. Choose a username and password to get started.',
  buttonLabel: 'Create account',
  redirectTo: '/',
};

// Sandbox disclosure lives here + in SandboxBanner, deliberately NOT in
// consent_documents (spec section 6: fake clients never log in, so no
// participant consent ever fires in a sandbox).
const SANDBOX_PAGE_OPTIONS: Omit<RegistrationPageOptions, 'intro'> = {
  title: 'Create your sandbox',
  buttonLabel: 'Create sandbox',
  busyLabel: 'Assembling your caseload…',
  redirectTo: '/admin',
  notice:
    'This is a demonstration sandbox. All client records are synthetic. ' +
    'Do not enter real patient information anywhere in this environment.',
};

function sandboxIntro(role: 'therapist' | 'caseworker'): string {
  return role === 'caseworker'
    ? 'You were invited to explore the care-coordinator (caseworker) dashboard with a pre-seeded synthetic caseload. Choose a username and password to get started.'
    : 'You were invited to explore the therapist dashboard with a pre-seeded synthetic caseload. Choose a username and password to get started.';
}

function isLiveInvite(invite: { used_at: string | null; expires_at: string } | null): boolean {
  if (!invite) return false;
  if (invite.used_at) return false;
  return new Date(invite.expires_at).getTime() > Date.now();
}

export default function joinRoutes(): Router {
  const router = Router();

  // Invite tokens are unguessable, but throttle probing anyway.
  const joinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in a few minutes.' },
  });

  // GET /join/:token — the registration page, or 410 for dead invites.
  router.get('/join/:token', joinLimiter, async (req, res) => {
    try {
      const invite = await findInviteByToken(req.params.token);
      if (!isLiveInvite(invite)) {
        return res.status(410).type('html').send(gonePage());
      }
      res.type('html').send(registrationPage(CLIENT_PAGE_OPTIONS));
    } catch (error) {
      log.error({ err: error }, 'Error loading invite page');
      res.status(500).json({ error: 'Failed to load invite' });
    }
  });

  // POST /join/:token — consume the invite, create + assign + log in.
  router.post('/join/:token', joinLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    // Server-side mirror of the page's username rules + password policy
    // (ai-therapist-154): nothing is consumed or hashed for a bad body.
    const usernameError = usernamePolicyError(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }
    const pwError = passwordPolicyError(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    try {
      // Atomic single-use gate: only one request can ever win this UPDATE.
      const invite = await consumeInvite(req.params.token);
      if (!invite) {
        return res.status(410).json({ error: GONE_MESSAGE });
      }

      // The consumed client inherits the inviter's care-team role and
      // organization (caseworker portal, spec section 2). An inviter who
      // vanished or is no longer a care-team member kills the invite (410),
      // matching the pre-portal rollback semantics below.
      const inviter = await getUserById(invite.therapist_id);
      const inviterRole = inviter?.role;
      if (!inviter || !isCareTeamRole(inviterRole)) {
        await releaseInvite(invite.invite_id).catch((releaseError: unknown) => {
          log.error({ err: releaseError }, 'Error releasing invite after inviter lookup failure');
        });
        return res.status(410).json({ error: GONE_MESSAGE });
      }

      let user;
      try {
        user = await registerAccount(username.trim(), password, 'participant', {
          orgId: invite.organization_id ?? inviter.organization_id ?? null,
          // C3: users.is_sandbox is set at creation from the org kind. A
          // sandbox owner minting a client invite must produce a sandbox
          // participant, or the account bypasses every sandbox exclusion
          // (crisis paging, dataset exports, stats).
          isSandbox: inviter.is_sandbox === true,
        });
      } catch (error: unknown) {
        // Registration failed — release the invite so the link stays usable.
        await releaseInvite(invite.invite_id).catch((releaseError: unknown) => {
          log.error({ err: releaseError }, 'Error releasing invite after failed registration');
        });
        if (error instanceof Error && error.message === 'Username already exists') {
          return res.status(409).json({ error: 'Username already exists' });
        }
        throw error;
      }

      // Caseload grant + 'invite_consumed' audit row + used_by stamp commit
      // together or not at all (ai-therapist-154): a grant can never exist
      // without its audit row. On failure undo everything — no orphaned
      // unassigned participant (removeAccount also drops the Squawk copy),
      // and the link stays usable if it was transient.
      try {
        await completeInviteGrant({
          inviteId: invite.invite_id,
          memberId: invite.therapist_id,
          memberRole: inviterRole,
          clientId: user.userid,
          clientUsername: user.username,
        });
      } catch (grantErr) {
        log.error({ err: grantErr }, 'Invite grant failed; rolling back registration');
        try { await removeAccount(user.userid); } catch (e) { log.error({ err: e }, 'orphan cleanup failed'); }
        try { await releaseInvite(invite.invite_id); } catch (e) { log.error({ err: e }, 'invite release failed'); }
        // The inviting member changed role between consume and grant: the
        // invite is dead (410). Anything else is an outage: 500.
        // Name check (not instanceof): route tests mock db/index.js wholesale.
        if (grantErr instanceof Error && grantErr.name === 'CaseloadRoleError') {
          return res.status(410).json({ error: GONE_MESSAGE });
        }
        return res.status(500).json({ error: 'Registration failed' });
      }

      // Establish the session, mirroring login (incl. org/sandbox stamps).
      req.session.userId = user.userid;
      req.session.username = user.username;
      req.session.userRole = user.role;
      req.session.mfaVerified = true;
      if (typeof user.organization_id === 'number') req.session.orgId = user.organization_id;
      req.session.isSandbox = user.is_sandbox === true;

      req.session.save((err) => {
        if (err) log.error({ err }, 'Session save error');
      });

      res.json({
        success: true,
        user: { userid: user.userid, username: user.username, role: user.role },
      });
    } catch (error) {
      log.error({ err: error }, 'Error completing invite registration');
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // GET /join-sandbox/:token — sandbox signup page (with the synthetic-data
  // disclosure), or 410 for dead invites.
  router.get('/join-sandbox/:token', joinLimiter, async (req, res) => {
    try {
      const invite = await findSandboxInviteByToken(req.params.token);
      if (!isLiveInvite(invite)) {
        return res.status(410).type('html').send(gonePage('Ask whoever sent it for a new one.'));
      }
      res.type('html').send(
        registrationPage({ ...SANDBOX_PAGE_OPTIONS, intro: sandboxIntro(invite!.invite_role) })
      );
    } catch (error) {
      log.error({ err: error }, 'Error loading sandbox invite page');
      res.status(500).json({ error: 'Failed to load invite' });
    }
  });

  // POST /join-sandbox/:token — consume the invite, create a fresh sandbox
  // org + owner account, seed the synthetic caseload (single transaction,
  // no LLM calls), then log the owner in. Compensating cleanup on failure
  // releases the invite so the link stays usable (spec section 7).
  router.post('/join-sandbox/:token', joinLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    // Server-side mirror of the page's username rules + password policy
    // (ai-therapist-154): nothing is consumed or hashed for a bad body.
    const usernameError = usernamePolicyError(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }
    const pwError = passwordPolicyError(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    try {
      // Atomic single-use gate (065 pattern): one request wins this UPDATE.
      const invite = await consumeSandboxInvite(req.params.token);
      if (!invite) {
        return res.status(410).json({ error: SANDBOX_GONE_MESSAGE });
      }

      const release = () =>
        releaseSandboxInvite(invite.invite_id).catch((err: unknown) => {
          log.error({ err }, 'Error releasing sandbox invite');
        });

      // 1. Fresh per-account sandbox org (C8: never shared across strangers).
      let org;
      try {
        org = await createOrganization({ name: `${username.trim()}'s Sandbox`, kind: 'sandbox' });
      } catch (error) {
        log.error({ err: error }, 'Sandbox org creation failed');
        await release();
        return res.status(500).json({ error: 'Could not create the sandbox. Please try again.' });
      }

      // 2. Owner account in the invite's role, flagged is_sandbox forever.
      let user;
      try {
        user = await registerAccount(username.trim(), password, invite.invite_role, {
          orgId: org.org_id,
          isSandbox: true,
        });
      } catch (error: unknown) {
        await deleteSandboxOrganization(org.org_id).catch((e: unknown) =>
          log.error({ err: e }, 'sandbox org cleanup failed')
        );
        await release();
        if (error instanceof Error && error.message === 'Username already exists') {
          return res.status(409).json({ error: 'Username already exists' });
        }
        log.error({ err: error }, 'Sandbox user creation failed');
        return res.status(500).json({ error: 'Registration failed' });
      }

      // 3. Deterministic synthetic caseload, one transaction (~1-2s, zero
      // model cost). token_hash seeds the PRNG so a re-run of the same link
      // (after a failure released it) produces the same caseload.
      let seeded;
      try {
        seeded = await seedSandboxCaseload({
          ownerId: user.userid,
          ownerUsername: user.username,
          ownerRole: invite.invite_role,
          orgId: org.org_id,
          tokenHash: invite.token_hash,
        });
      } catch (seedErr) {
        log.error({ err: seedErr }, 'Sandbox seeding failed; rolling back signup');
        try { await removeAccount(user.userid); } catch (e) { log.error({ err: e }, 'sandbox owner cleanup failed'); }
        try { await deleteSandboxOrganization(org.org_id); } catch (e) { log.error({ err: e }, 'sandbox org cleanup failed'); }
        await release();
        return res.status(500).json({ error: 'Could not assemble the sandbox. Please try again.' });
      }

      // Invite bookkeeping + its 'invite_consumed' audit row are one
      // transaction (ai-therapist-154).
      try {
        await markSandboxInviteUsedAudited(invite.invite_id, user.userid, org.org_id, {
          therapistId: user.userid,
          clientId: null,
          actorUserId: user.userid,
          actorUsername: user.username,
          detail: {
            sandbox: true,
            invite_id: invite.invite_id,
            batch_id: invite.batch_id,
            org_id: org.org_id,
            seeded_clients: seeded.clientIds.length,
            seeded_sessions: seeded.sessionCount,
          },
        });
      } catch (markErr) {
        // Full compensation: seeded users first (org FK is RESTRICT), then
        // the owner, then the org, then the invite.
        log.error({ err: markErr }, 'Sandbox invite bookkeeping failed; rolling back signup');
        for (const seededId of seeded.seededUserIds) {
          try { await removeAccount(seededId); } catch (e) { log.error({ err: e }, 'seeded user cleanup failed'); }
        }
        try { await removeAccount(user.userid); } catch (e) { log.error({ err: e }, 'sandbox owner cleanup failed'); }
        try { await deleteSandboxOrganization(org.org_id); } catch (e) { log.error({ err: e }, 'sandbox org cleanup failed'); }
        await release();
        return res.status(500).json({ error: 'Could not assemble the sandbox. Please try again.' });
      }

      // Establish the session, mirroring login (incl. org/sandbox stamps).
      req.session.userId = user.userid;
      req.session.username = user.username;
      req.session.userRole = user.role;
      req.session.mfaVerified = true;
      if (typeof user.organization_id === 'number') req.session.orgId = user.organization_id;
      req.session.isSandbox = true;

      req.session.save((err) => {
        if (err) log.error({ err }, 'Session save error');
      });

      res.json({
        success: true,
        user: { userid: user.userid, username: user.username, role: user.role },
        sandbox: {
          orgId: org.org_id,
          clients: seeded.clientIds.length,
          sessions: seeded.sessionCount,
        },
      });
    } catch (error) {
      log.error({ err: error }, 'Error completing sandbox registration');
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  return router;
}
