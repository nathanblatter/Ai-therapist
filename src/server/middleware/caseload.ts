// Caseload enforcement middleware (ai-therapist-119, caseload RBAC MVP).
// Row-scopes therapist accounts to their assigned clients; researcher and
// demo roles pass through untouched. Unassigned resources return 404 (never
// 403) so a therapist cannot confirm the existence of unassigned data.
// Spec: docs/caseload-rbac.md.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isAssigned, getSessionAccessInfo, getMessageOwner } from '../db/index.js';

/**
 * Gate a `:userId`-scoped route. researcher/demo pass through; a therapist
 * gets 404 unless the target user is in their caseload. Non-numeric ids -> 400.
 */
export function requireClientAccess(paramName?: string): RequestHandler {
  const param = paramName ?? 'userId';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = req.session.userRole;
    if (role !== 'therapist') {
      next();
      return;
    }

    const clientId = Number(req.params[param]);
    if (!Number.isInteger(clientId)) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const therapistId = req.session.userId;
    isAssigned(therapistId, clientId)
      .then((assigned: boolean) => {
        if (!assigned) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        next();
      })
      .catch(next);
  };
}

/**
 * Gate a `:sessionId`-scoped route. Resolves the therapy session's owner via
 * getSessionAccessInfo; 404 if the session doesn't exist. researcher/demo
 * pass through (including for missing sessions — downstream handlers keep
 * their own 404 behavior); a therapist gets 404 unless the session's owner is
 * an assigned client. Sessions with null user_id -> 404 for therapists.
 */
export function requireSessionClientAccess(paramName?: string): RequestHandler {
  const param = paramName ?? 'sessionId';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = req.session.userRole;
    if (role !== 'therapist') {
      next();
      return;
    }

    const sessionId = req.params[param];
    const therapistId = req.session.userId;

    getSessionAccessInfo(String(sessionId))
      .then(async (info) => {
        if (!info) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const ownerId = info.user_id === null ? null : Number(info.user_id);
        if (ownerId === null || !Number.isInteger(ownerId)) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const assigned = await isAssigned(therapistId, ownerId);
        if (!assigned) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        next();
      })
      .catch(next);
  };
}

/**
 * The scope id handed to scoped list queries: the therapist's own userId when
 * the caller is a therapist, otherwise null (unscoped).
 */
export async function therapistScopeId(req: Request): Promise<number | null> {
  if (req.session?.userRole === 'therapist' && typeof req.session.userId === 'number') {
    return req.session.userId;
  }
  return null;
}

/**
 * Socket-layer live-monitoring check: researcher always allowed; therapist
 * allowed only for assigned clients' sessions; everyone else denied.
 */
export async function canAdminAccessSessionLive(
  role: string | undefined,
  adminUserId: number | undefined,
  sessionUserId: number | null
): Promise<boolean> {
  if (role === 'researcher') return true;
  if (role !== 'therapist') return false;
  if (adminUserId === undefined || sessionUserId === null) return false;
  return isAssigned(adminUserId, sessionUserId);
}


/**
 * Gate a `:messageId`-addressed route (message edit/delete). researcher/demo
 * pass through; a therapist gets 404 unless the message's owning session
 * belongs to an assigned client. Same 404-over-403 semantics as the rest of
 * the caseload middleware.
 */
export function requireMessageClientAccess(paramName = 'messageId'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.session?.userRole !== 'therapist') return next();
    const raw = req.params[paramName];
    const messageId = Number(raw);
    if (!Number.isInteger(messageId)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }
    try {
      const owner = await getMessageOwner(messageId);
      if (!owner || owner.user_id == null) {
        return res.status(404).json({ error: 'Not found' });
      }
      const ok = await isAssigned(req.session.userId as number, Number(owner.user_id));
      if (!ok) return res.status(404).json({ error: 'Not found' });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
