// Multi-factor authentication routes (TOTP setup, verify, disable, backup codes).
// All require an authenticated session.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';

export default function mfaRoutes(): Router {
  const router = Router();

  // GET /api/mfa/status - MFA status for the current user
  router.get('/api/mfa/status', requireAuth, async (req, res) => {
    try {
      const { getMFAStatus } = await import('../../services/mfa.service.js');
      const status = await getMFAStatus(req.session.userId!);
      const { secret: _secret, ...statusWithoutSecret } = status;
      res.json({ success: true, mfa: statusWithoutSecret });
    } catch (error) {
      console.error('Failed to get MFA status:', error);
      res.status(500).json({ error: 'Failed to get MFA status' });
    }
  });

  // POST /api/mfa/setup/init - generate secret + QR code
  router.post('/api/mfa/setup/init', requireAuth, async (req, res) => {
    try {
      const { generateMFASecret, generateQRCode } = await import('../../services/mfa.service.js');

      if (req.session.userRole !== 'therapist' && req.session.userRole !== 'researcher') {
        return res.status(403).json({ error: 'MFA is only available for therapist and researcher accounts' });
      }

      const { secret, otpauthUrl } = generateMFASecret(req.session.username!);
      const qrCode = await generateQRCode(otpauthUrl!);

      // Hold the secret in the session until setup is verified.
      req.session.tempMFASecret = secret;

      res.json({ success: true, secret, qrCode });
    } catch (error) {
      console.error('Failed to initialize MFA setup:', error);
      res.status(500).json({ error: 'Failed to initialize MFA setup' });
    }
  });

  // POST /api/mfa/setup/verify - verify token and enable MFA
  router.post('/api/mfa/setup/verify', requireAuth, async (req, res) => {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    try {
      const { verifyTOTP, generateBackupCodes, enableMFA } = await import('../../services/mfa.service.js');

      const secret = req.session.tempMFASecret;
      if (!secret) {
        return res.status(400).json({ error: 'MFA setup not initialized. Please start setup again.' });
      }

      if (!verifyTOTP(token, secret)) {
        return res.status(401).json({ error: 'Invalid token. Please try again.' });
      }

      const { codes, hashedCodes } = await generateBackupCodes(10);
      await enableMFA(req.session.userId!, secret, hashedCodes);
      delete req.session.tempMFASecret;

      res.json({ success: true, message: 'MFA enabled successfully', backupCodes: codes });
    } catch (error) {
      console.error('Failed to verify MFA setup:', error);
      res.status(500).json({ error: 'Failed to complete MFA setup' });
    }
  });

  // POST /api/mfa/disable - disable MFA (password-confirmed)
  router.post('/api/mfa/disable', requireAuth, async (req, res) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required to disable MFA' });
    }

    try {
      const { verifyCredentials } = await import('../../db/index.js');
      const { disableMFA } = await import('../../services/mfa.service.js');

      const user = await verifyCredentials(req.session.username!, password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid password' });
      }

      await disableMFA(req.session.userId!);
      res.json({ success: true, message: 'MFA disabled successfully' });
    } catch (error) {
      console.error('Failed to disable MFA:', error);
      res.status(500).json({ error: 'Failed to disable MFA' });
    }
  });

  // POST /api/mfa/regenerate-backup-codes - issue fresh backup codes (password-confirmed)
  router.post('/api/mfa/regenerate-backup-codes', requireAuth, async (req, res) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required to regenerate backup codes' });
    }

    try {
      const { verifyCredentials } = await import('../../db/index.js');
      const { generateBackupCodes, updateBackupCodes, getMFAStatus } = await import('../../services/mfa.service.js');

      const user = await verifyCredentials(req.session.username!, password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid password' });
      }

      const mfaStatus = await getMFAStatus(req.session.userId!);
      if (!mfaStatus.enabled) {
        return res.status(400).json({ error: 'MFA is not enabled' });
      }

      const { codes, hashedCodes } = await generateBackupCodes(10);
      await updateBackupCodes(req.session.userId!, hashedCodes);

      res.json({ success: true, message: 'Backup codes regenerated successfully', backupCodes: codes });
    } catch (error) {
      console.error('Failed to regenerate backup codes:', error);
      res.status(500).json({ error: 'Failed to regenerate backup codes' });
    }
  });

  return router;
}
