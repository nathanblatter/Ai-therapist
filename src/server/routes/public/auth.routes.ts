// Authentication routes: login (with MFA), register, logout, status.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../../middleware/auth.js';
import { verifyCredentials } from '../../db/index.js';
import { passwordPolicyError } from '../../utils/passwordPolicy.js';
import { registerAccount } from '../../services/accounts.service.js';
import { enabled as squawkEnabled } from '../../services/squawk.service.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('authRoutes');

export default function authRoutes(): Router {
  const router = Router();

  // Brute-force protection: successful logins don't count, so a legitimate
  // shared-lab IP isn't locked out by normal use.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in a few minutes.' },
  });

  // POST /api/auth/login
  router.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password, mfaToken, backupCode } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    // With Squawk configured the local hash is a stale copy: sign-in goes
    // through /api/auth/squawk/* (the login page does this on its own).
    if (squawkEnabled()) {
      return res
        .status(410)
        .json({ error: 'Sign in through the login page; password login moved to Squawk', code: 'use_squawk' });
    }

    try {
      const user = await verifyCredentials(username, password);

      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (user.mfa_enabled) {
        // MFA enabled — require a token or backup code.
        if (!mfaToken && !backupCode) {
          return res.json({ success: false, mfaRequired: true, userId: user.userid });
        }

        const { verifyTOTP, verifyBackupCode, updateBackupCodes, updateMFAVerificationTime } = await import(
          '../../services/mfa.service.js'
        );

        let mfaValid = false;

        if (mfaToken) {
          mfaValid = verifyTOTP(mfaToken, user.mfa_secret ?? '');
        } else if (backupCode) {
          const verification = await verifyBackupCode(backupCode, user.mfa_backup_codes ?? []);
          mfaValid = verification.valid;
          if (mfaValid) {
            await updateBackupCodes(user.userid, verification.remainingCodes);
          }
        }

        if (!mfaValid) {
          return res.status(401).json({ error: 'Invalid MFA token or backup code' });
        }

        await updateMFAVerificationTime(user.userid);
      }

      // Establish the session on a FRESH session id: regenerating on login
      // both blocks session fixation and guarantees no field stamped for a
      // previous account survives — orgIdFor short-circuits on a session
      // orgId, so a stale value from an earlier login on this browser would
      // scope the new user's org-gated queries to the WRONG organization.
      // State that belongs to the browser/human rather than the account
      // (consent acceptance, anonymous session ownership) is carried over.
      const carried = {
        ownedSessions: req.session.ownedSessions,
        consentAccepted: req.session.consentAccepted,
        consentVersion: req.session.consentVersion,
        consentAcceptedAt: req.session.consentAcceptedAt,
      };
      req.session.regenerate((regenErr) => {
        if (regenErr) {
          log.error({ err: regenErr }, 'Session regenerate error');
          return res.status(500).json({ error: 'Login failed' });
        }
        Object.assign(req.session, carried);
        // orgId/isSandbox (caseworker portal, 069/077) are stamped here so
        // org scoping never needs a per-request lookup.
        req.session.userId = user.userid;
        req.session.username = user.username;
        req.session.userRole = user.role;
        req.session.mfaVerified = true;
        if (typeof user.organization_id === 'number') req.session.orgId = user.organization_id;
        req.session.isSandbox = user.is_sandbox === true;

        req.session.save((err) => {
          if (err) {
            log.error({ err }, 'Session save error');
            return res.status(500).json({ error: 'Login failed' });
          }
          res.json({
            success: true,
            user: { userid: user.userid, username: user.username, role: user.role },
          });
        });
      });
    } catch (error) {
      log.error({ err: error }, 'Login error');
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // POST /api/auth/register (researcher only)
  router.post('/api/auth/register', requireRole('researcher'), async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }
    if (!['therapist', 'researcher', 'participant', 'caseworker'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const pwError = passwordPolicyError(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    try {
      const user = await registerAccount(username, password, role);
      res.json({
        success: true,
        user: { userid: user.userid, username: user.username, role: user.role },
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      // Name check (not instanceof): route tests mock db/index.js wholesale,
      // which would leave the class binding undefined.
      if (error instanceof Error && error.name === 'ResearchOrgCaseworkerError') {
        return res.status(400).json({ error: error.message });
      }
      log.error({ err: error }, 'Registration error');
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // POST /api/auth/logout
  router.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        log.error({ err }, 'Logout error');
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  // GET /api/auth/status
  router.get('/api/auth/status', (req, res) => {
    if (req.session?.userId) {
      res.json({
        authenticated: true,
        user: {
          userid: req.session.userId,
          username: req.session.username,
          role: req.session.userRole,
          // Sandbox flag (caseworker portal): drives the persistent sandbox
          // banner. False for every session established before 077 shipped.
          is_sandbox: req.session.isSandbox === true,
        },
      });
    } else {
      res.json({ authenticated: false });
    }
  });

  return router;
}
