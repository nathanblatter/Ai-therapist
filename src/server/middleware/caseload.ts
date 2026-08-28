// Care-team enforcement middleware (ai-therapist-119 caseload RBAC MVP,
// generalized for the caseworker portal — docs/caseworker-portal.md).
// Row-scopes care-team accounts (therapist AND caseworker) to their assigned
// clients; researcher and demo roles pass through untouched. Unassigned
// resources return 404 (never 403) so a care-team member cannot confirm the
// existence of unassigned data. Spec: docs/caseload-rbac.md.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  isAssigned,
  getSessionAccessInfo,
  getMessageOwner,
  getCareNoteById,
  getEscalationById,
} from '../db/index.js';
import { isCareTeamRole } from '../../shared/roles.js';
import { orgIdFor } from './org.js';

/**
 * Gate a `:userId`-scoped route. researcher/demo pass through; a care-team
 * member (therapist or caseworker) gets 404 unless the target user is in
 * their caseload. Non-numeric ids -> 400.
 */
export function requireClientAccess(paramName?: string): RequestHandler {
  const param = paramName ?? 'userId';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = req.session.userRole;
    if (!isCareTeamRole(role)) {
      next();
      return;
    }

    const clientId = Number(req.params[param]);
    if (!Number.isInteger(clientId)) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const memberId = req.session.userId;
    isAssigned(memberId, clientId)
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
 * their own 404 behavior); a care-team member gets 404 unless the session's
 * owner is an assigned client. Sessions with null user_id -> 404 for
 * care-team members.
 */
export function requireSessionClientAccess(paramName?: string): RequestHandler {
  const param = paramName ?? 'sessionId';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = req.session.userRole;
    if (!isCareTeamRole(role)) {
      next();
      return;
    }

    const sessionId = req.params[param];
    const memberId = req.session.userId;

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
        const assigned = await isAssigned(memberId, ownerId);
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
 * The scope id handed to scoped list queries: the care-team member's own
 * userId when the caller is a therapist or caseworker, otherwise null
 * (unscoped — researchers, org-scoped separately via orgIdFor).
 */
export async function careTeamScopeId(req: Request): Promise<number | null> {
  if (isCareTeamRole(req.session?.userRole) && typeof req.session?.userId === 'number') {
    return req.session.userId;
  }
  return null;
}

/** @deprecated Renamed careTeamScopeId (caseworker portal); same semantics. */
export const therapistScopeId = careTeamScopeId;

/**
 * Socket-layer live-monitoring check: researcher always allowed; therapist
 * allowed only for assigned clients' sessions; caseworker explicitly denied
 * (live transcripts are full-tier content); everyone else denied.
 */
export async function canAdminAccessSessionLive(
  role: string | undefined,
  adminUserId: number | undefined,
  sessionUserId: number | null
): Promise<boolean> {
  if (role === 'researcher') return true;
  if (role === 'caseworker') return false; // summaries tier: never live transcript streams
  if (role !== 'therapist') return false;
  if (adminUserId === undefined || sessionUserId === null) return false;
  return isAssigned(adminUserId, sessionUserId);
}


/**
 * Gate a `:messageId`-addressed route (message edit/delete). researcher/demo
 * pass through; a care-team member gets 404 unless the message's owning
 * session belongs to an assigned client. Same 404-over-403 semantics as the
 * rest of the caseload middleware. (Caseworkers are additionally excluded
 * from these routes at the requireFullContent allowlist level.)
 */
export function requireMessageClientAccess(paramName = 'messageId'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isCareTeamRole(req.session?.userRole)) return next();
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

/**
 * Gate a route whose target client id arrives in the request BODY (e.g.
 * POST /admin/api/escalations with body.client_id). Care-team members must
 * have the client on caseload (404-over-403); researcher/demo pass through.
 * Missing/non-integer client id -> 400 for everyone (the handler needs it).
 */
export function requireBodyClientAccess(field = 'client_id'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const clientId = Number((req.body ?? {})[field]);
    if (!Number.isInteger(clientId)) {
      return res.status(400).json({ error: `Invalid ${field}` });
    }
    if (!isCareTeamRole(req.session.userRole)) return next();
    try {
      const assigned = await isAssigned(req.session.userId, clientId);
      if (!assigned) return res.status(404).json({ error: 'Not found' });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Gate a `:noteId`-addressed care_notes route per the visibility matrix
 * (docs/caseworker-portal.md section 2):
 *   - researcher (and every non-care-team role): 404 — notes are blocked v1.
 *   - author: always sees their own note.
 *   - therapist on the client's care team: all care-team notes.
 *   - caseworker on the client's care team: case notes, plus progress notes
 *     only when shared_with_care_team.
 * Loads the note once and attaches it as res.locals.careNote for the handler.
 * Missing note or no visibility -> 404 (never 403).
 */
export function requireNoteAccess(paramName = 'noteId'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const noteId = Number(req.params[paramName]);
    if (!Number.isInteger(noteId)) {
      return res.status(400).json({ error: 'Invalid note id' });
    }
    const role = req.session.userRole;
    const userId = req.session.userId;
    if (!isCareTeamRole(role)) {
      // Notes are clinical documentation: blocked for researchers (Q7) and
      // every other non-care-team role. 404 so existence is not confirmed.
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const note = await getCareNoteById(noteId);
      if (!note) return res.status(404).json({ error: 'Not found' });

      if (note.author_id === userId) {
        res.locals.careNote = note;
        return next();
      }
      const onCareTeam = await isAssigned(userId, note.client_id);
      if (!onCareTeam) return res.status(404).json({ error: 'Not found' });
      if (role === 'caseworker' && note.note_type === 'progress' && !note.shared_with_care_team) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.locals.careNote = note;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Gate an `:escalationId`-addressed escalations route (docs/caseworker-portal.md
 * section 2): researcher passes org-scoped (metadata reads); therapist passes
 * as assignee, for caseload clients, or for same-org unassigned escalations;
 * caseworker passes as raiser or care-team member of the client. Everyone
 * else, and every miss, gets 404. Attaches res.locals.escalation.
 */
export function requireEscalationAccess(paramName = 'escalationId'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const escalationId = Number(req.params[paramName]);
    if (!Number.isInteger(escalationId)) {
      return res.status(400).json({ error: 'Invalid escalation id' });
    }
    const role = req.session.userRole;
    const userId = req.session.userId;
    try {
      const escalation = await getEscalationById(escalationId);
      if (!escalation) return res.status(404).json({ error: 'Not found' });

      if (role === 'researcher') {
        // Fail closed: orgIdFor only returns null for unauthenticated
        // callers (impossible past the session check above) — but if that
        // invariant ever breaks, an unresolved org must read as 404, not as
        // an all-orgs pass.
        const orgId = await orgIdFor(req);
        if (orgId === null || orgId !== escalation.org_id) {
          return res.status(404).json({ error: 'Not found' });
        }
        res.locals.escalation = escalation;
        return next();
      }

      if (role === 'therapist') {
        if (escalation.assigned_to === userId || (await isAssigned(userId, escalation.client_id))) {
          res.locals.escalation = escalation;
          return next();
        }
        if (escalation.assigned_to === null) {
          const orgId = await orgIdFor(req);
          if (orgId !== null && orgId === escalation.org_id) {
            res.locals.escalation = escalation;
            return next();
          }
        }
        return res.status(404).json({ error: 'Not found' });
      }

      if (role === 'caseworker') {
        if (escalation.raised_by === userId || (await isAssigned(userId, escalation.client_id))) {
          res.locals.escalation = escalation;
          return next();
        }
        return res.status(404).json({ error: 'Not found' });
      }

      return res.status(404).json({ error: 'Not found' });
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Escalation-create link check (red-team round 3, finding 7): a note_id
 * attached to an escalation must reference an existing care note for the
 * SAME client, or a raiser could hand the assignee clinical documentation
 * about a different participant. Mirrors the crisis_event_id/session_id
 * ownership checks in escalations.routes.ts.
 */
export async function careNoteBelongsToClient(noteId: number, clientId: number): Promise<boolean> {
  const note = await getCareNoteById(noteId);
  return note !== null && note.client_id === clientId;
}
