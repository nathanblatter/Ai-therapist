// Participant consent screen API. Acceptance is stored on the browser's
// express-session (so requireConsent can gate /token and /api/chat/start) and
// durably in participant_consents: once at accept time (session_id NULL,
// user_id set if logged in) and again per-session once a session actually
// starts (see token.routes.ts / chat.routes.ts).
import { Router } from 'express';
import { recordConsent } from '../../db/index.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { CURRENT_CONSENT_VERSION } from '../../utils/consent.js';

export default function consentRoutes(): Router {
  const router = Router();

  // GET /api/consent/status - has this browser session already accepted the
  // current consent version? Also returns whether recording is enabled so the
  // client can render the right copy before the user even opens the screen.
  router.get('/api/consent/status', async (req, res) => {
    try {
      const config = await getSystemConfig();
      const recordingEnabled = (config.features?.session_recording_enabled as boolean | undefined) ?? false;
      const accepted = !!req.session?.consentAccepted && req.session.consentVersion === CURRENT_CONSENT_VERSION;
      res.json({
        accepted,
        currentVersion: CURRENT_CONSENT_VERSION,
        acceptedVersion: req.session?.consentVersion ?? null,
        acceptedAt: req.session?.consentAcceptedAt ?? null,
        recordingEnabled,
      });
    } catch (err) {
      console.error('Failed to fetch consent status:', err);
      res.status(500).json({ error: 'Failed to fetch consent status' });
    }
  });

  // POST /api/consent/accept - record acceptance of the current consent copy.
  router.post('/api/consent/accept', async (req, res) => {
    try {
      const { consentVersion } = req.body as { consentVersion?: string };
      if (consentVersion !== CURRENT_CONSENT_VERSION) {
        // Client is showing stale copy (or bypassing the UI) - reject so the
        // caller re-fetches /api/consent/status and shows the current screen.
        return res.status(409).json({
          error: 'stale_consent_version',
          currentVersion: CURRENT_CONSENT_VERSION,
        });
      }

      const config = await getSystemConfig();
      const recordingEnabled = (config.features?.session_recording_enabled as boolean | undefined) ?? false;
      const acceptedAt = new Date().toISOString();

      if (!req.session) {
        return res.status(500).json({ error: 'No session available to record consent' });
      }
      req.session.consentAccepted = true;
      req.session.consentVersion = consentVersion;
      req.session.consentAcceptedAt = acceptedAt;

      // Durable per-user record for logged-in participants (session_id is
      // filled in separately once an actual therapy session starts).
      const userId = req.session.userId ?? null;
      await recordConsent({
        sessionId: null,
        userId,
        consentVersion,
        recordingEnabled,
      });

      res.json({ success: true, consentVersion, acceptedAt, recordingEnabled });
    } catch (err) {
      console.error('Failed to record consent:', err);
      res.status(500).json({ error: 'Failed to record consent' });
    }
  });

  return router;
}
