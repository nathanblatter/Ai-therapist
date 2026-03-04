import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole, verifyCredentials, createUser } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

export default function authRoutes() {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later' }
  });

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many registration attempts, please try again later' }
  });

  // POST /api/auth/login
  router.post("/api/auth/login", loginLimiter, asyncHandler(async (req, res) => {
    const { username, password, mfaToken, backupCode } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await verifyCredentials(username, password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    log.debug({ mfaEnabled: user.mfa_enabled, mfaTokenProvided: !!mfaToken, backupCodeProvided: !!backupCode }, 'MFA check');

    if (user.mfa_enabled) {
      if (!mfaToken && !backupCode) {
        log.info('Returning mfaRequired response');
        return res.json({
          success: false,
          mfaRequired: true,
          userId: user.userid
        });
      }

      const { verifyTOTP, verifyBackupCode, updateBackupCodes, updateMFAVerificationTime } = await import('../services/mfa.service.js');

      let mfaValid = false;

      if (mfaToken) {
        mfaValid = verifyTOTP(mfaToken, user.mfa_secret);
      } else if (backupCode) {
        const verification = await verifyBackupCode(backupCode, user.mfa_backup_codes);
        mfaValid = verification.valid;

        if (mfaValid) {
          await updateBackupCodes(user.userid, verification.remainingCodes);
          log.info(`Backup code used for user ${user.username}. Remaining codes: ${verification.remainingCodes.length}`);
        }
      }

      if (!mfaValid) {
        return res.status(401).json({ error: 'Invalid MFA token or backup code' });
      }

      await updateMFAVerificationTime(user.userid);
    }

    req.session.userId = user.userid;
    req.session.username = user.username;
    req.session.userRole = user.role;
    req.session.mfaVerified = true;

    req.session.save((err) => {
      if (err) {
        log.error({ err }, 'Session save error');
      } else {
        log.info({ userId: user.userid, username: user.username, role: user.role }, 'User logged in and session saved');
      }
    });

    res.json({
      success: true,
      user: {
        userid: user.userid,
        username: user.username,
        role: user.role
      }
    });
  }));

  // POST /api/auth/register
  router.post("/api/auth/register", registerLimiter, requireRole('researcher'), asyncHandler(async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }

    if (!['therapist', 'researcher', 'participant'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    try {
      const user = await createUser(username, password, role);
      res.json({
        success: true,
        user: { userid: user.userid, username: user.username, role: user.role }
      });
    } catch (error) {
      if (error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      throw error;
    }
  }));

  // POST /api/auth/logout
  router.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        log.error({ err }, 'Logout error');
        return res.status(500).json({ error: 'Logout failed' });
      }
      res.json({ success: true });
    });
  });

  // GET /api/auth/status
  router.get("/api/auth/status", (req, res) => {
    if (req.session?.userId) {
      res.json({
        authenticated: true,
        user: {
          userid: req.session.userId,
          username: req.session.username,
          role: req.session.userRole
        }
      });
    } else {
      res.json({ authenticated: false });
    }
  });

  // ===================== MFA Routes =====================

  // GET /api/mfa/status
  router.get("/api/mfa/status", requireAuth, asyncHandler(async (req, res) => {
    const { getMFAStatus } = await import('../services/mfa.service.js');
    const status = await getMFAStatus(req.session.userId);
    delete status.secret;
    res.json({ success: true, mfa: status });
  }));

  // POST /api/mfa/setup/init
  router.post("/api/mfa/setup/init", requireAuth, asyncHandler(async (req, res) => {
    const { generateMFASecret, generateQRCode } = await import('../services/mfa.service.js');

    if (req.session.userRole !== 'therapist' && req.session.userRole !== 'researcher') {
      return res.status(403).json({ error: 'MFA is only available for therapist and researcher accounts' });
    }

    const { secret, otpauthUrl } = generateMFASecret(req.session.username);
    const qrCode = await generateQRCode(otpauthUrl);
    req.session.tempMFASecret = secret;

    res.json({ success: true, secret, qrCode });
  }));

  // POST /api/mfa/setup/verify
  router.post("/api/mfa/setup/verify", requireAuth, asyncHandler(async (req, res) => {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { verifyTOTP, generateBackupCodes, enableMFA } = await import('../services/mfa.service.js');
    const secret = req.session.tempMFASecret;

    if (!secret) {
      return res.status(400).json({ error: 'MFA setup not initialized. Please start setup again.' });
    }

    const isValid = verifyTOTP(token, secret);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid token. Please try again.' });
    }

    const { codes, hashedCodes } = await generateBackupCodes(10);
    await enableMFA(req.session.userId, secret, hashedCodes);
    delete req.session.tempMFASecret;

    log.info(`MFA enabled for user ${req.session.username}`);

    res.json({
      success: true,
      message: 'MFA enabled successfully',
      backupCodes: codes
    });
  }));

  // POST /api/mfa/disable
  router.post("/api/mfa/disable", requireAuth, asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required to disable MFA' });
    }

    const { verifyCredentials: verify } = await import('../middleware/auth.js');
    const { disableMFA } = await import('../services/mfa.service.js');

    const user = await verify(req.session.username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    await disableMFA(req.session.userId);
    log.info(`MFA disabled for user ${req.session.username}`);

    res.json({ success: true, message: 'MFA disabled successfully' });
  }));

  // POST /api/mfa/regenerate-backup-codes
  router.post("/api/mfa/regenerate-backup-codes", requireAuth, asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required to regenerate backup codes' });
    }

    const { verifyCredentials: verify } = await import('../middleware/auth.js');
    const { generateBackupCodes, updateBackupCodes, getMFAStatus } = await import('../services/mfa.service.js');

    const user = await verify(req.session.username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const mfaStatus = await getMFAStatus(req.session.userId);
    if (!mfaStatus.enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    const { codes, hashedCodes } = await generateBackupCodes(10);
    await updateBackupCodes(req.session.userId, hashedCodes);

    log.info(`Backup codes regenerated for user ${req.session.username}`);

    res.json({
      success: true,
      message: 'Backup codes regenerated successfully',
      backupCodes: codes
    });
  }));

  return router;
}
