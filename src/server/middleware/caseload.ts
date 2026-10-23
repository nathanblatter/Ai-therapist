// Care-team enforcement middleware (ai-therapist-119 caseload RBAC MVP,
// generalized for the caseworker portal — docs/caseworker-portal.md).
// Row-scopes care-team accounts (therapist AND caseworker) to their assigned
// clients; researchers are organization-scoped (ai-therapist-269: the target
// participant's organization_id must equal the caller's, anonymous sessions
// are IRB-study custody); demo passes through untouched. Out-of-scope
// resources return 404 (never 403) so a caller cannot confirm the existence
// of data they may not see. Spec: docs/caseload-rbac.md.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  isAssigned,
  getSessionAccessInfo,
  getMessageOwner,
  getCareNoteById,
  getEscalationById,
  getOrganizationIdForUser,
  getIrbStudyOrgId,
} from '../db/index.js';
import { isCareTeamRole } from '../../shared/roles.js';
import { orgIdFor } from './org.js';

/**
 * Researcher organization rule (ai-therapist-269). A researcher may read a
 * participant-scoped resource only when the participant's organization_id
 * equals their own (orgIdFor). An ownerless resource (anonymous session,
 * `user_id` NULL) is IRB-study custody: visible only when the caller's org is
 * the irb-study org. Fail closed: a missing/unresolvable org on either side
 * is a deny, and a thrown lookup error propagates to the caller's catch
 * (-> 500), never widening to an all-orgs pass.
 *
 * @param ownerOrgId the participant's organization_id when the caller already
 *   loaded it (joined row); `undefined` asks for a lookup by `ownerId`.
 */
async function researcherMayAccess(req: Request, ownerId: number | null, ownerOrgId?: number | null): Promise<boolean> {
  return researcherOrgAllows(await orgIdFor(req), ownerId, ownerOrgId);
}

/**
 * The researcher organization rule on already-resolved ids (ai-therapist-272),
 * for callers that hold the caller's org without a Request (socket layer,
 * body/query-addressed session guards). Same contract as researcherMayAccess:
 * null caller org -> deny; ownerless (anonymous) resource -> irb-study org
 * only; otherwise the owner's org must equal the caller's. `ownerOrgId`
 * undefined asks for one users lookup by `ownerId`.
 */
export async function researcherOrgAllows(
  callerOrgId: number | null,
  ownerId: number | null,
  ownerOrgId?: number | null,
): Promise<boolean> {
  if (callerOrgId === null) return false;
  if (ownerId === null) {
    return (await getIrbStudyOrgId()) === callerOrgId;
  }
  const targetOrgId = ownerOrgId === undefined ? await getOrganizationIdForUser(ownerId) : ownerOrgId;
  return typeof targetOrgId === 'number' && targetOrgId === callerOrgId;
}

/**
 * Gate a `:userId`-scoped route. demo passes through; a researcher gets 404
 * unless the target user is in their organization (one users lookup); a
 * care-team member (therapist or caseworker) gets 404 unless the target user
 * is in their caseload. Non-numeric ids -> 400.
 */
export function requireClientAccess(paramName?: string): RequestHandler {
  const param = paramName ?? 'userId';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = req.session.userRole;
    if (role !== 'researcher' && !isCareTeamRole(role)) {
      next();
      return;
    }

    const clientId = Number(req.params[param]);
    if (!Number.isInteger(clientId)) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    if (role === 'researcher') {
      researcherMayAccess(req, clientId)
        .then((ok) => {
          if (!ok) {
            res.status(404).json({ error: 'Not found' });
            return;
          }
          next();
        })
        .catch(next);
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
 * Gate a `:sessionId`-scoped route. Resolves the therapy session's owner (and
 * the owner's organization) in one getSessionAccessInfo query; 404 if the
 * session doesn't exist. demo passes through (downstream handlers keep their
 * own 404 behavior); a researcher gets 404 unless the owner is in their
 * organization, or — for a session with null user_id — unless their
 * organization is the irb-study org; a care-team member gets 404 unless the
 * session's owner is an assigned client. Sessions with null user_id -> 404
 * for care-team members.
 */
export function requireSessionClientAccess(paramName?: string): RequestHandler {
  const param = paramName ?? 'sessionId';
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = req.session.userRole;
    if (role !== 'researcher' && !isCareTeamRole(role)) {
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
        if (role === 'researcher') {
          const ownerIdOrNull = ownerId !== null && Number.isInteger(ownerId) ? ownerId : null;
          const ok = await researcherMayAccess(req, ownerIdOrNull, info.owner_organization_id ?? null);
          if (!ok) {
            res.status(404).json({ error: 'Not found' });
            return;
          }
          next();
          return;
        }
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
 * Socket-layer live-monitoring check: researcher allowed only when the
 * session owner is in their organization (`callerOrgId`, resolved once by the
 * caller from the socket's express session; anonymous session -> irb-study
 * org only; `sessionOwnerOrgId` undefined asks for one users lookup —
 * ai-therapist-272); therapist allowed only for assigned clients' sessions;
 * caseworker explicitly denied (live transcripts are full-tier content);
 * everyone else denied.
 */
export async function canAdminAccessSessionLive(
  role: string | undefined,
  adminUserId: number | undefined,
  sessionUserId: number | null,
  callerOrgId: number | null,
  sessionOwnerOrgId?: number | null,
): Promise<boolean> {
  if (role === 'researcher') return researcherOrgAllows(callerOrgId, sessionUserId, sessionOwnerOrgId);
  if (role === 'caseworker') return false; // summaries tier: never live transcript streams
  if (role !== 'therapist') return false;
  if (adminUserId === undefined || sessionUserId === null) return false;
  return isAssigned(adminUserId, sessionUserId);
}

/**
 * Caseload guard for session ids arriving outside a :sessionId path param
 * (query string / request body), where requireSessionClientAccess cannot
 * apply. Single choke point for the per-route policies:
 *   - a researcher passes only when the session exists and its owner is in
 *     `opts.callerOrgId` (the caller's org, resolved once via orgIdFor);
 *     an anonymous session only for the irb-study org (ai-therapist-272);
 *   - other non-care-team roles (demo, ...) always pass — requireRole gates
 *     them separately;
 *   - a therapist passes only when the session exists, has an owner, and
 *     that owner is on their caseload (404-never-403 semantics at the caller);
 *   - a caseworker follows `caseworkerPolicy`: 'assigned' = same caseload
 *     check as a therapist (summaries-tier surfaces, e.g. crisis metadata);
 *     'deny' = never, regardless of assignment (full-tier surfaces such as
 *     live sideband control — mirrors canAdminAccessSessionLive).
 */
export async function mayCareTeamAccessSession(
  role: string | undefined,
  userId: number | undefined,
  sessionId: string,
  opts: { caseworkerPolicy: 'deny' | 'assigned'; callerOrgId: number | null },
): Promise<boolean> {
  if (role === 'researcher') {
    if (opts.callerOrgId === null) return false;
    const info = await getSessionAccessInfo(String(sessionId));
    if (!info) return false;
    const ownerId = info.user_id === null || info.user_id === undefined ? null : Number(info.user_id);
    return researcherOrgAllows(opts.callerOrgId, ownerId, info.owner_organization_id ?? null);
  }
  if (!isCareTeamRole(role)) return true;
  if (role === 'caseworker' && opts.caseworkerPolicy === 'deny') return false;
  if (userId === undefined) return false;
  const info = await getSessionAccessInfo(String(sessionId));
  if (!info || info.user_id === null || info.user_id === undefined) return false;
  return isAssigned(userId, Number(info.user_id));
}

/**
 * Gate a `:messageId`-addressed route (message edit/delete). demo passes
 * through; a researcher gets 404 unless the message's owning session belongs
 * to a participant in their organization (anonymous session: irb-study org
 * only) — one getMessageOwner query; a care-team member gets 404 unless the
 * message's owning session belongs to an assigned client. Same 404-over-403
 * semantics as the rest of the caseload middleware. (Caseworkers are
 * additionally excluded from these routes at the requireFullContent
 * allowlist level.)
 */
export function requireMessageClientAccess(paramName = 'messageId'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const role = req.session?.userRole;
    if (role !== 'researcher' && !isCareTeamRole(role)) return next();
    const raw = req.params[paramName];
    const messageId = Number(raw);
    if (!Number.isInteger(messageId)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }
    try {
      const owner = await getMessageOwner(messageId);
      if (role === 'researcher') {
        if (!owner) return res.status(404).json({ error: 'Not found' });
        const ownerId = owner.user_id == null ? null : Number(owner.user_id);
        const ok = await researcherMayAccess(req, ownerId, owner.owner_organization_id ?? null);
        if (!ok) return res.status(404).json({ error: 'Not found' });
        return next();
      }
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
 * have the client on caseload (404-over-403); a researcher must share the
 * client's organization (404-over-403, one users lookup); demo passes
 * through. Missing/non-integer client id -> 400 for everyone (the handler
 * needs it).
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
    const role = req.session.userRole;
    if (role === 'researcher') {
      try {
        if (!(await researcherMayAccess(req, clientId))) {
          return res.status(404).json({ error: 'Not found' });
        }
        return next();
      } catch (err) {
        return next(err);
      }
    }
    if (!isCareTeamRole(role)) return next();
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
