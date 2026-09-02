// Blocks NEW participant sessions during quiet hours (10:00 PM - 6:00 AM
// America/Denver, per the Phase 2 IRB application and consent form). Only
// participants are gated: researcher/therapist/caseworker accounts must be
// able to work overnight (crisis review), demo accounts are not study
// participants, and sandbox users are internal testers. Sessions already in
// progress are never cut off — this middleware sits only on session-start
// routes (/token, /api/chat/start, /api/sessions/create).
import type { Request, Response, NextFunction } from 'express';
import { getQuietHoursStatus } from '../utils/quietHours.js';

export function requireOutsideQuietHours(req: Request, res: Response, next: NextFunction): void {
  const role = req.session?.userRole ?? 'participant';
  if (role !== 'participant' || req.session?.isSandbox) {
    next();
    return;
  }
  const status = getQuietHoursStatus();
  if (!status.active) {
    next();
    return;
  }
  res.status(403).json({
    error: 'quiet_hours',
    message:
      'The app is closed overnight (10:00 PM to 6:00 AM Mountain Time). ' +
      'If you need support right now, please use the crisis resources shown.',
    quietHours: status,
  });
}
