// Blocks session start until the participant has accepted the CURRENT consent
// copy (recording, transcription, live admin monitoring, retention,
// crisis-protocol disclosure). The active version is the newest consent_documents
// row (migration 047), looked up via getActiveConsent (cached ~30s). Bumping the
// active version invalidates every browser session's stored consentVersion, so
// this same gate doubles as the re-consent gate. Acceptance is recorded on
// req.session by POST /api/consent/accept (see routes/public/consent.routes.ts).
import type { Request, Response, NextFunction } from 'express';
import { getActiveConsent } from '../utils/consent.js';

export async function requireConsent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const active = await getActiveConsent();
  if (req.session?.consentAccepted && req.session.consentVersion === active.version) {
    next();
    return;
  }
  res.status(412).json({
    error: 'consent_required',
    message: 'Participant consent is required before starting a session.',
    currentVersion: active.version,
    // true => they accepted an OLDER version and must re-consent.
    reconsent: !!req.session?.consentVersion,
  });
}
