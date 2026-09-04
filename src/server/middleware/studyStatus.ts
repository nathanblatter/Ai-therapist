// Blocks NEW sessions for participants who withdrew from (or paused) the
// study via the withdrawal survey (migration 087). Mirrors the quiet-hours
// gate: participants only, session-start routes only, sessions already in
// progress are never cut off. Withdrawn/paused participants can still log in,
// view their data, and use /api/me/export — withdrawal ends data COLLECTION,
// not account access.
import type { Request, Response, NextFunction } from 'express';
import { getStudyStatus } from '../db/studyStatus.queries.js';

export async function requireActiveStudyStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
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
    console.error('[StudyStatus] gate lookup failed:', err);
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
