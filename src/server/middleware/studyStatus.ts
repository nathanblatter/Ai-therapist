// Blocks NEW sessions for participants who withdrew from (or paused) the
// study via the withdrawal survey (migration 087). Mirrors the quiet-hours
// gate: participants only, session-start routes only, sessions already in
// progress are never cut off. Withdrawn/paused participants can still log in,
// view their data, and use /api/me/export — withdrawal ends data COLLECTION,
// not account access.
import type { Request, Response, NextFunction } from 'express';
import { getStudyStatus } from '../db/studyStatus.queries.js';

import { createLogger } from '../utils/logger.js';

const log = createLogger('studyStatusMiddleware');

export async function requireActiveStudyStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  const role = req.session?.userRole ?? 'participant';
  if (role !== 'participant' || req.session?.isSandbox || !req.session?.userId) {
    next();
    return;
  }
  let status;
  try {
    status = await getStudyStatus(req.session.userId);
  } catch (err) {
    // Fail open: a transient DB error must not lock active participants out.
    log.error({ err }, 'gate lookup failed');
    next();
    return;
  }
  if (status === 'active') {
    next();
    return;
  }
  res.status(403).json({
    error: 'study_status',
    studyStatus: status,
    message:
      status === 'paused'
        ? 'Your study participation is paused. Contact the research team when you are ready to resume. ' +
          'If you need support right now, please use the crisis resources shown.'
        : 'You have withdrawn from the study, so new sessions are closed. ' +
          'If you need support right now, please use the crisis resources shown.',
  });
}

// ---------------------------------------------------------------------------
// Data collection after withdrawal (ai-therapist-322).
//
// The consent form says the app "collects nothing after you withdraw from the
// study". requireActiveStudyStatus closes session START; the two middlewares
// below close the participant-linked write routes that do not start a session.
//
// Scope, deliberately:
//   - Withdrawn only. "paused" is a temporary hold the participant asked for,
//     not a revocation of consent; it already blocks new sessions.
//   - Logged-in, non-sandbox participants only (the same population the start
//     gate covers). Anonymous browsers have no study status.
//   - Read paths, consent, crisis resources, settings, data export and
//     messages to the study/care team are NOT gated: withdrawal ends
//     collection, not access or contact.
//   - The live conversation of a session that was already running when the
//     status changed (transcript upload, typed text, tool outcomes, ending the
//     session) is not cut off, matching the start gate's "never cut off a
//     session in progress": the crisis pipeline reads that transcript. No new
//     session can begin after withdrawal, so this cannot grow.
//
// Fails open on a lookup error, like the start gate: a DB blip must not break
// an active participant's screener or feedback.
// ---------------------------------------------------------------------------

/** True when this request comes from a logged-in participant who has withdrawn. */
export async function isWithdrawnParticipant(req: Request): Promise<boolean> {
  const role = req.session?.userRole ?? 'participant';
  if (role !== 'participant' || req.session?.isSandbox || !req.session?.userId) return false;
  try {
    return (await getStudyStatus(req.session.userId)) === 'withdrawn';
  } catch (err) {
    log.error({ err }, 'withdrawal lookup failed');
    return false;
  }
}

/**
 * For fire-and-forget beacons and uploads (client error telemetry, engagement
 * telemetry, session audio): answer 204 and store nothing. A beacon cannot
 * read or retry a response, so a refusal would change nothing for the
 * participant; 204 is also what these routes already answer for a disabled
 * stream, so the client needs no new branch.
 */
export async function dropIfWithdrawn(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isWithdrawnParticipant(req)) {
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * For deliberate submissions the participant sees an answer to (screener,
 * worksheet, post-session feedback, practice completion): refuse with 403 so
 * the screen can say why, instead of pretending it was saved.
 */
export async function refuseIfWithdrawn(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isWithdrawnParticipant(req)) {
    res.status(403).json({
      error: 'study_status',
      studyStatus: 'withdrawn',
      message:
        'You have withdrawn from the study, so the app no longer saves study responses. ' +
        'You can still contact the research team, and the crisis resources are always available.',
    });
    return;
  }
  next();
}
