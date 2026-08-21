// Admin view/management of persisted login sessions (researcher only).
// Caseload RBAC review (ai-therapist-119): these routes are researcher-only
// and researchers are unscoped, so no requireClientAccess/therapistScopeId
// threading applies here; login sessions are also not a participant-scoped
// therapy surface.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getActiveUserSessions, deleteUserSession } from '../../db/index.js';

export default function userSessionsRoutes(): Router {
  const router = Router();

  // GET /admin/api/user-sessions - list sessions with decoded user info
  router.get('/admin/api/user-sessions', requireRole('researcher'), async (_req, res) => {
    try {
      const rows = await getActiveUserSessions();

      const sessions = rows.map((row) => {
        let sessData: Record<string, unknown> = {};
        try {
          sessData = typeof row.sess === 'string'
            ? (JSON.parse(row.sess) as Record<string, unknown>)
            : (row.sess as Record<string, unknown>);
        } catch (err) {
          console.error('Failed to parse session data:', err);
        }

        return {
          sid: row.sid,
          expire: row.expire,
          userId: sessData['userId'],
          username: sessData['username'],
          userRole: sessData['userRole'],
          cookie: sessData['cookie'],
        };
      });

      res.json(sessions);
    } catch (err) {
      console.error('Failed to fetch user sessions:', err);
      res.status(500).json({ error: 'Failed to fetch user sessions' });
    }
  });

  // DELETE /admin/api/user-sessions/:sid - force-logout a session
  router.delete('/admin/api/user-sessions/:sid', requireRole('researcher'), async (req, res) => {
    const { sid } = req.params;
    try {
      const deletedSid = await deleteUserSession(sid);
      if (!deletedSid) {
        return res.status(404).json({ error: 'Session not found' });
      }
      console.log(`[Admin] Session ${sid} deleted by ${req.session.username}`);
      res.json({ message: 'Session deleted successfully', sid: deletedSid });
    } catch (err) {
      console.error('Failed to delete user session:', err);
      res.status(500).json({ error: 'Failed to delete user session' });
    }
  });

  return router;
}
