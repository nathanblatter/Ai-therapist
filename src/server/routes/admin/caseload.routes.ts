// Caseload assignment API (ai-therapist-119, caseload RBAC MVP).
// Therapists read their own caseload; researchers see and manage the full
// assignment matrix. Spec: docs/caseload-rbac.md.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  assignClient,
  unassignClient,
  insertCaseloadAudit,
  listCaseloadAudit,
  listCaseload,
  listAllAssignments,
  getAllUsers,
  CaseloadRoleError,
} from '../../db/index.js';

export default function caseloadRoutes(): Router {
  const router = Router();

  // GET /admin/api/caseload - therapist: own caseload; researcher: all assignments
  router.get('/admin/api/caseload', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      if (req.session.userRole === 'therapist') {
        const clients = await listCaseload(req.session.userId!);
        return res.json({ clients });
      }
      const assignments = await listAllAssignments();
      res.json({ assignments });
    } catch (err) {
      console.error('Failed to fetch caseload:', err);
      res.status(500).json({ error: 'Failed to fetch caseload' });
    }
  });

  // GET /admin/api/caseload/therapists - researcher-only therapist roster
  router.get('/admin/api/caseload/therapists', requireRole('researcher'), async (_req, res) => {
    try {
      const users = await getAllUsers();
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
  router.get('/admin/api/caseload/audit', requireRole('researcher'), async (_req, res) => {
    try {
      const rows = await listCaseloadAudit();
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

    try {
      await assignClient(therapistId, clientId, req.session.userId ?? null);
      void insertCaseloadAudit({
        action: 'assign', therapistId, clientId,
        actorUserId: req.session.userId ?? null,
        actorUsername: req.session.username ?? null,
      });
      res.json({ success: true, therapistId, clientId });
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
      const removed = await unassignClient(therapistId, clientId);
      if (removed) {
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
