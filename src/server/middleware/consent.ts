// Blocks session start until the participant has accepted the current consent
// screen (recording, transcription, live admin monitoring, retention,
// crisis-protocol disclosure). Acceptance is recorded on req.session by
// POST /api/consent/accept (see routes/public/consent.routes.ts).
import type { Request, Response, NextFunction } from 'express';
import { CURRENT_CONSENT_VERSION } from '../utils/consent.js';

export function requireConsent(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.consentAccepted && req.session.consentVersion === CURRENT_CONSENT_VERSION) {
    next();
    return;
  }
  res.status(412).json({
    error: 'consent_required',
    message: 'Participant consent is required before starting a session.',
    currentVersion: CURRENT_CONSENT_VERSION,
  });
}
