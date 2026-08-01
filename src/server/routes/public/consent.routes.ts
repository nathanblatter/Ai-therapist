// Participant consent screen API. Acceptance is stored on the browser's
// express-session (so requireConsent can gate /token and /api/chat/start) and
// durably in participant_consents: once at accept time (session_id NULL,
// user_id set if logged in) and again per-session once a session actually
// starts (see token.routes.ts / chat.routes.ts). The active consent copy +
// version + hash come from consent_documents (migration 047) via getActiveConsent.
import { Router } from 'express';
import { recordConsent, getLatestConsentForUser } from '../../db/index.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { getActiveConsent } from '../../utils/consent.js';

export default function consentRoutes(): Router {
  const router = Router();

  // GET /api/consent/status - has this browser session already accepted the
  // current consent version? Returns the active body + version so the client
  // can render the exact copy, whether recording is enabled (for the
  // client-rendered recording bullet), and whether the user is re-consenting.
  router.get('/api/consent/status', async (req, res) => {
    try {
      const [config, active] = await Promise.all([getSystemConfig(), getActiveConsent()]);
      const recordingEnabled = (config.features?.session_recording_enabled as boolean | undefined) ?? false;

      // For a logged-in user, a durable DB acceptance at the active version
      // counts even on a fresh browser session (e.g. a new device): promote it
      // onto this session so we don't re-prompt someone who already agreed.
      const userId = req.session?.userId ?? null;
      if (userId && req.session && req.session.consentVersion !== active.version) {
        const latest = await getLatestConsentForUser(userId);
        if (latest && latest.consent_version === active.version) {
          req.session.consentAccepted = true;
          req.session.consentVersion = latest.consent_version;
          req.session.consentAcceptedAt = latest.accepted_at instanceof Date
            ? latest.accepted_at.toISOString()
            : String(latest.accepted_at);
        }
      }

      const accepted = !!req.session?.consentAccepted && req.session.consentVersion === active.version;
      const acceptedVersion = req.session?.consentVersion ?? null;
      res.json({
        accepted,
        currentVersion: active.version,
        body: active.body,
        acceptedVersion,
        acceptedAt: req.session?.consentAcceptedAt ?? null,
        recordingEnabled,
        // true => they previously accepted an OLDER version and must re-accept.
        reconsentRequired: !accepted && !!acceptedVersion,
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
      const active = await getActiveConsent();
      if (consentVersion !== active.version) {
        // Client is showing stale copy (or bypassing the UI) - reject so the
        // caller re-fetches /api/consent/status and shows the current screen.
        return res.status(409).json({
          error: 'stale_consent_version',
          currentVersion: active.version,
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
      // filled in separately once an actual therapy session starts). The
      // body_hash proves exactly which document text was accepted.
      const userId = req.session.userId ?? null;
      await recordConsent({
        sessionId: null,
        userId,
        consentVersion,
        recordingEnabled,
        bodyHash: active.bodyHash,
      });

      res.json({ success: true, consentVersion, acceptedAt, recordingEnabled });
    } catch (err) {
      console.error('Failed to record consent:', err);
      res.status(500).json({ error: 'Failed to record consent' });
    }
  });

  return router;
}
