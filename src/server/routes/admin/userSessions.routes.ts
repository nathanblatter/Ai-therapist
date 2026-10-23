// Admin view/management of persisted login sessions (researcher only).
// Caseload RBAC review (ai-therapist-119): these routes are researcher-only
// and login sessions are not a participant-scoped therapy surface, so no
// requireClientAccess/therapistScopeId threading applies here.
// Organization scoping (ai-therapist-272): both routes are scoped to the
// caller's organization via a users join on sess->>'userId' inside the
// queries; sessions with no userId are IRB-study custody (irb-study org
// only). A session outside the scope reads as 404 — never 403.
import { Router, type Request } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { getActiveUserSessions, deleteUserSession } from '../../db/index.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('userSessionsRoutes');

/** The caller's org; orgIdFor throws on lookup failure (-> 500), and null
 *  (unauthenticated) cannot happen past requireRole — treat it as a failure
 *  too rather than widening to an unscoped read. */
async function callerOrgId(req: Request): Promise<number> {
  const orgId = await orgIdFor(req);
  if (orgId === null) throw new Error('[userSessions] unauthenticated caller reached a scoped read');
  return orgId;
}

export default function userSessionsRoutes(): Router {
  const router = Router();

  // GET /admin/api/user-sessions - list sessions with decoded user info
  router.get('/admin/api/user-sessions', requireRole('researcher'), async (req, res) => {
    try {
      const rows = await getActiveUserSessions(await callerOrgId(req));

      const sessions = rows.map((row) => {
        let sessData: Record<string, unknown> = {};
        try {
          sessData = typeof row.sess === 'string'
            ? (JSON.parse(row.sess) as Record<string, unknown>)
            : (row.sess as Record<string, unknown>);
        } catch (err) {
          log.error({ err }, 'Failed to parse session data');
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
      log.error({ err }, 'Failed to fetch user sessions');
      res.status(500).json({ error: 'Failed to fetch user sessions' });
    }
  });

  // DELETE /admin/api/user-sessions/:sid - force-logout a session
  router.delete('/admin/api/user-sessions/:sid', requireRole('researcher'), async (req, res) => {
    const { sid } = req.params;
    try {
      const deletedSid = await deleteUserSession(sid, await callerOrgId(req));
      if (!deletedSid) {
        return res.status(404).json({ error: 'Session not found' });
      }
      log.info(`[Admin] Session ${sid} deleted by ${req.session.username}`);
      res.json({ message: 'Session deleted successfully', sid: deletedSid });
    } catch (err) {
      log.error({ err }, 'Failed to delete user session');
      res.status(500).json({ error: 'Failed to delete user session' });
    }
  });

  return router;
}
