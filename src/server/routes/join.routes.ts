// Public client self-registration via a therapist's one-time invite link
// (ai-therapist-119, caseload RBAC).
//   - GET  /join/:token — minimal self-contained registration page (or a 410
//     page when the invite is unknown, already used, or expired).
//   - POST /join/:token — atomically consumes the invite, creates a
//     participant account, auto-assigns it to the inviting therapist, and
//     establishes the session exactly like login does.
// The raw token is never reflected into HTML (the page reads it from
// location.pathname) and only its sha256 hash is ever compared in the DB.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  findInviteByToken,
  consumeInvite,
  releaseInvite,
  markInviteUsedBy,
  createUser,
  assignClient,
  insertCaseloadAudit,
} from '../db/index.js';

const GONE_MESSAGE = 'This invite link is no longer valid. Ask your therapist for a new one.';

function registrationPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Create your account</title>
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
</style>
</head>
<body>
<div class="card">
  <h1>Create your account</h1>
  <p>Your therapist invited you to this platform. Choose a username and password to get started.</p>
  <form id="join-form">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" required minlength="3" maxlength="64">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
    <button type="submit" id="submit-btn">Create account</button>
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
        location.href = '/';
        return;
      }
      errorEl.textContent = data.error || 'Registration failed. Please try again.';
      errorEl.style.display = 'block';
    } catch (err) {
      errorEl.textContent = 'Network error. Please try again.';
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

function gonePage(): string {
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
  <p>It may have expired or already been used. Ask your therapist for a new one.</p>
</div>
</body>
</html>`;
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
      res.type('html').send(registrationPage());
    } catch (error) {
      console.error('Error loading invite page:', error);
      res.status(500).json({ error: 'Failed to load invite' });
    }
  });

  // POST /join/:token — consume the invite, create + assign + log in.
  router.post('/join/:token', joinLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      // Atomic single-use gate: only one request can ever win this UPDATE.
      const invite = await consumeInvite(req.params.token);
      if (!invite) {
        return res.status(410).json({ error: GONE_MESSAGE });
      }

      let user;
      try {
        user = await createUser(username.trim(), password, 'participant');
      } catch (error: unknown) {
        // Registration failed — release the invite so the link stays usable.
        await releaseInvite(invite.invite_id).catch((releaseError: unknown) => {
          console.error('Error releasing invite after failed registration:', releaseError);
        });
        if (error instanceof Error && error.message === 'Username already exists') {
          return res.status(409).json({ error: 'Username already exists' });
        }
        throw error;
      }

      await assignClient(invite.therapist_id, user.userid, invite.therapist_id);
      void insertCaseloadAudit({
        action: 'invite_consumed',
        therapistId: invite.therapist_id,
        clientId: user.userid,
        actorUserId: user.userid,
        actorUsername: user.username,
        detail: { invite_id: invite.invite_id },
      });
      await markInviteUsedBy(invite.invite_id, user.userid);

      // Establish the session, mirroring login.
      req.session.userId = user.userid;
      req.session.username = user.username;
      req.session.userRole = user.role;
      req.session.mfaVerified = true;

      req.session.save((err) => {
        if (err) console.error('Session save error:', err);
      });

      res.json({
        success: true,
        user: { userid: user.userid, username: user.username, role: user.role },
      });
    } catch (error) {
      console.error('Error completing invite registration:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  return router;
}
