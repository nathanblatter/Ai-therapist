// Blocks NEW participant sessions during quiet hours (10:00 PM - 6:00 AM
// America/Denver, per the Phase 2 IRB application and consent form). Only
// participants are gated: researcher/therapist/caseworker accounts must be
// able to work overnight (crisis review), demo accounts are not study
// participants, and sandbox users are internal testers. Sessions already in
// progress are never cut off — this middleware sits only on session-start
// routes (/token, /api/chat/start, /api/sessions/create).
import type { Request, Response, NextFunction } from 'express';
import { getQuietHoursStatus } from '../utils/quietHours.js';

/**
 * Whether this request resumes a session that OpenAI's content filter
 * terminated, rather than starting a new one.
 *
 * `recovery` is the voice path; `continued_from` is the text fallback. Both mean
 * the participant was already mid-conversation — and in the observed 2026-09-11
 * incident had just disclosed suicidal intent when the platform cut them off.
 * Gates that exist to stop someone STARTING a session must not strand them
 * there.
 */
export function isCrisisContinuation(req: Request): boolean {
  return req.body?.recovery === true || typeof req.body?.continued_from === 'string';
}

export function requireOutsideQuietHours(req: Request, res: Response, next: NextFunction): void {
  const role = req.session?.userRole ?? 'participant';
  if (role !== 'participant' || req.session?.isSandbox) {
    next();
    return;
  }
  // Quiet hours block NEW sessions. Resuming after a content-filter termination
  // is not a new session — and 10pm-6am is precisely when a participant in
  // crisis is most likely to be alone. Blocking the assistant's return here
  // would make the overnight window the one where we hang up and stay hung up.
  if (isCrisisContinuation(req)) {
    console.warn('[QuietHours] Bypassed for a crisis continuation — resuming a terminated session.');
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
