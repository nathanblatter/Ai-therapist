// Caseload assignment API (ai-therapist-119, caseload RBAC MVP).
// Therapists read their own caseload; researchers see and manage the full
// assignment matrix. Spec: docs/caseload-rbac.md.
import { Router, type Request } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  assignClient,
  unassignClient,
  insertCaseloadAudit,
  listCaseloadAudit,
  listCaseload,
  listAllAssignments,
  getAllUsers,
  freezeThreadsForPair,
  getOrganizationIdForUser,
  CaseloadRoleError,
} from '../../db/index.js';
import { revokeTherapistSessionRooms } from '../../utils/adminBroadcast.js';
import { userRoom } from '../../services/messageSafety.service.js';
import { orgIdFor } from '../../middleware/org.js';
import { isCareTeamRole, type CareTeamRole } from '../../../shared/roles.js';

export default function caseloadRoutes(): Router {
  const router = Router();

  /**
   * Caller-org gate for assign/unassign (C13): a researcher may only rewire
   * care teams inside their OWN organization. Both the member and the client
   * must be in the caller's org; any mismatch — including a nonexistent
   * account — reads as 404 so a cross-org researcher cannot distinguish
   * "exists elsewhere" from "does not exist" (404-over-403).
   */
  async function callerOwnsPair(req: Request, memberId: number, clientId: number): Promise<boolean> {
    const callerOrgId = await orgIdFor(req);
    if (callerOrgId === null) return false;
    const [memberOrg, clientOrg] = await Promise.all([
      getOrganizationIdForUser(memberId),
      getOrganizationIdForUser(clientId),
    ]);
    return memberOrg === callerOrgId && clientOrg === callerOrgId;
  }

  // GET /admin/api/caseload - care-team member (therapist/caseworker): own
  // caseload; researcher: all assignments
  router.get('/admin/api/caseload', requireRole('therapist', 'researcher', 'caseworker'), async (req, res) => {
    try {
      if (isCareTeamRole(req.session.userRole)) {
        const clients = await listCaseload(req.session.userId!);
        return res.json({ clients });
      }
      // C13: researchers are org-scoped — other orgs' (incl. sandbox)
      // assignment matrices never mix into the study view.
      const assignments = await listAllAssignments(await orgIdFor(req));
      res.json({ assignments });
    } catch (err) {
      console.error('Failed to fetch caseload:', err);
      res.status(500).json({ error: 'Failed to fetch caseload' });
    }
  });

  // GET /admin/api/caseload/therapists - researcher-only therapist roster
  // (org-scoped, C13)
  router.get('/admin/api/caseload/therapists', requireRole('researcher'), async (req, res) => {
    try {
      const users = await getAllUsers(null, (await orgIdFor(req)) ?? undefined);
      const therapists = users
        .filter(u => u.role === 'therapist')
        .map(u => ({ userid: u.userid, username: u.username, created_at: u.created_at ?? null }));
      res.json({ therapists });
    } catch (err) {
      console.error('Failed to fetch therapists:', err);
      res.status(500).json({ error: 'Failed to fetch therapists' });
    }
  });

  // POST /admin/api/caseload/:therapistId/:clientId - researcher-only assign
  // GET /admin/api/caseload/audit - append-only assignment/invite audit trail
  // (org-scoped, C13)
  router.get('/admin/api/caseload/audit', requireRole('researcher'), async (req, res) => {
    try {
      const rows = await listCaseloadAudit(undefined, await orgIdFor(req));
      res.json({ audit: rows });
    } catch (err) {
      console.error('Failed to fetch caseload audit log:', err);
      res.status(500).json({ error: 'Failed to fetch caseload audit log' });
    }
  });

  router.post('/admin/api/caseload/:therapistId/:clientId', requireRole('researcher'), async (req, res) => {
    const therapistId = parseInt(req.params.therapistId, 10);
    const clientId = parseInt(req.params.clientId, 10);
    if (!Number.isInteger(therapistId) || !Number.isInteger(clientId)) {
      return res.status(400).json({ error: 'Invalid therapist or client id' });
    }

    // Care-team role for the edge (caseworker portal): defaults to therapist;
    // body { member_role: 'caseworker' } assigns a caseworker edge instead.
    const memberRole: CareTeamRole =
      req.body?.member_role === 'caseworker' ? 'caseworker' : 'therapist';

    try {
      // Caller-org == target-org (C13): never rewire another org's care team.
      if (!(await callerOwnsPair(req, therapistId, clientId))) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (memberRole === 'caseworker') {
        await assignClient(therapistId, clientId, req.session.userId ?? null, 'caseworker');
      } else {
        await assignClient(therapistId, clientId, req.session.userId ?? null);
      }
      void insertCaseloadAudit({
        action: 'assign', therapistId, clientId,
        actorUserId: req.session.userId ?? null,
        actorUsername: req.session.username ?? null,
        detail: memberRole === 'caseworker' ? { member_role: memberRole } : undefined,
      });
      res.json({ success: true, therapistId, clientId, memberRole });
    } catch (err) {
      if (err instanceof CaseloadRoleError) {
        return res.status(400).json({ error: (err as Error).message });
      }
      console.error('Failed to assign client:', err);
      res.status(500).json({ error: 'Failed to assign client' });
    }
  });

  // DELETE /admin/api/caseload/:therapistId/:clientId - researcher-only unassign
  router.delete('/admin/api/caseload/:therapistId/:clientId', requireRole('researcher'), async (req, res) => {
    const therapistId = parseInt(req.params.therapistId, 10);
    const clientId = parseInt(req.params.clientId, 10);
    if (!Number.isInteger(therapistId) || !Number.isInteger(clientId)) {
      return res.status(400).json({ error: 'Invalid therapist or client id' });
    }

    try {
      // Caller-org == target-org (C13), same gate as assign: unassigning is
      // as destructive as assigning (it severs monitoring + freezes threads).
      if (!(await callerOwnsPair(req, therapistId, clientId))) {
        return res.status(404).json({ error: 'Not found' });
      }
      const removed = await unassignClient(therapistId, clientId);
      if (removed) {
        if (global.io) {
          void revokeTherapistSessionRooms(global.io, therapistId, clientId);
        }
        // Messaging (docs/caseworker-portal.md section 3): unassignment
        // freezes the pair's thread (read-only, retained; re-assignment
        // unfreezes the same thread). Best-effort — a freeze failure must
        // not fail the unassign itself; the send gate still 409s frozen
        // threads and the pair's caseload access is already revoked.
        try {
          const frozenThreadIds = await freezeThreadsForPair(therapistId, clientId, 'unassigned');
          if (global.io) {
            for (const threadId of frozenThreadIds) {
              const payload = { threadId, reason: 'unassigned' };
              global.io.to(userRoom(therapistId)).emit('messaging:thread-frozen', payload);
              global.io.to(userRoom(clientId)).emit('messaging:thread-frozen', payload);
            }
          }
        } catch (err) {
          console.error('Failed to freeze message threads on unassign:', err);
        }
        void insertCaseloadAudit({
          action: 'unassign', therapistId, clientId,
          actorUserId: req.session.userId ?? null,
          actorUsername: req.session.username ?? null,
        });
      }
      res.json({ success: true, removed, therapistId, clientId });
    } catch (err) {
      console.error('Failed to unassign client:', err);
      res.status(500).json({ error: 'Failed to unassign client' });
    }
  });

  return router;
}
