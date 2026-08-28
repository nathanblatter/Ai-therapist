// Messaging route guards (caseworker portal, docs/caseworker-portal.md
// section 3). One thread per (client, clinician) pair; a request may only see
// a thread it is a party to. 404-over-403 everywhere so thread existence is
// never confirmed to a non-party.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { getThreadById } from '../db/index.js';

export interface ThreadGateOptions {
  /** When true (message send), an existing-but-frozen thread is a 409
   *  `thread_frozen` instead of a pass-through. */
  requireActive?: boolean;
  /** The route param carrying the thread id. */
  paramName?: string;
}

function parseThreadId(req: Request, paramName: string): number | null {
  const threadId = Number(req.params[paramName]);
  return Number.isInteger(threadId) ? threadId : null;
}

/**
 * Participant side: 404 unless the thread's client_id is the caller.
 * Attaches res.locals.thread for the handler.
 */
export function requireThreadParticipant(options: ThreadGateOptions = {}): RequestHandler {
  const { requireActive = false, paramName = 'threadId' } = options;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const threadId = parseThreadId(req, paramName);
    if (threadId === null) return res.status(400).json({ error: 'Invalid thread id' });
    try {
      const thread = await getThreadById(threadId);
      if (!thread || thread.client_id !== req.session.userId) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (requireActive && thread.status !== 'active') {
        return res.status(409).json({ error: 'thread_frozen' });
      }
      res.locals.thread = thread;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Clinician side: 404 unless the thread's clinician_id is the caller.
 * Attaches res.locals.thread for the handler.
 */
export function requireThreadClinician(options: ThreadGateOptions = {}): RequestHandler {
  const { requireActive = false, paramName = 'threadId' } = options;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const threadId = parseThreadId(req, paramName);
    if (threadId === null) return res.status(400).json({ error: 'Invalid thread id' });
    try {
      const thread = await getThreadById(threadId);
      if (!thread || thread.clinician_id !== req.session.userId) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (requireActive && thread.status !== 'active') {
        return res.status(409).json({ error: 'thread_frozen' });
      }
      res.locals.thread = thread;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Message-send throttle: ~30 messages/hour per authenticated user (keyed by
 * session userId, not IP, so a shared clinic network is not collectively
 * limited). Applied to the participant send route; clinician sends share it.
 */
export const messagingRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `user:${req.session?.userId ?? 'anon'}`,
  message: { error: 'Message rate limit reached. Please try again later.' },
});
