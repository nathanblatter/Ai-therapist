import { Router } from 'express';
import { pool } from '../../config/db.js';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createLogger } from '../../utils/logger.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { getNextMidnightSLC, getHoursUntilReset } from '../../utils/timezoneHelpers.js';

const log = createLogger('admin:users');

export default function adminUsersRoutes() {
  const router = Router();

  // GET /admin/api/user-sessions - Get all active user sessions
  router.get('/admin/api/user-sessions', requireRole('researcher'), asyncHandler(async (req, res) => {
    log.info('Fetching active user sessions');

    const result = await pool.query(
      `SELECT
        sid,
        sess,
        expire
      FROM user_sessions
      ORDER BY expire DESC`
    );

    // Parse the sess JSON and extract relevant fields
    const sessions = result.rows.map(row => {
      let sessData = {};
      try {
        sessData = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
      } catch (err) {
        log.error({ err, sid: row.sid }, 'Failed to parse session data');
      }

      return {
        sid: row.sid,
        expire: row.expire,
        userId: sessData.userId,
        username: sessData.username,
        userRole: sessData.userRole,
        cookie: sessData.cookie
      };
    });

    res.json(sessions);
  }));

  // DELETE /admin/api/user-sessions/:sid - Delete specific session
  router.delete('/admin/api/user-sessions/:sid', requireRole('researcher'), asyncHandler(async (req, res) => {
    const { sid } = req.params;
    const adminUsername = req.session.username;

    log.info({ sid, adminUsername }, 'Deleting user session');

    const result = await pool.query(
      'DELETE FROM user_sessions WHERE sid = $1 RETURNING sid',
      [sid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    log.info({ sid, adminUsername }, 'User session deleted');

    res.json({
      message: 'Session deleted successfully',
      sid: result.rows[0].sid
    });
  }));

  // GET /admin/api/rate-limits/users - Get all rate-limited users
  router.get('/admin/api/rate-limits/users', requireRole('therapist', 'researcher'), asyncHandler(async (req, res) => {
    log.info('Fetching rate-limited users');

    const config = await getSystemConfig();
    const limits = config.session_limits || { enabled: false };

    if (!limits.enabled) {
      return res.json({ rateLimitedUsers: [], config: limits });
    }

    // Get today's start in SLC time
    const todayStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
    todayStart.setHours(0, 0, 0, 0);

    const result = await pool.query(`
      SELECT
        u.userid,
        u.username,
        u.role,
        COUNT(ts.session_id) AS sessions_today,
        MAX(ts.created_at) AS last_session_at
      FROM users u
      LEFT JOIN therapy_sessions ts ON u.userid = ts.user_id
        AND ts.created_at >= $1
      WHERE u.role = 'participant'
      GROUP BY u.userid, u.username, u.role
      HAVING COUNT(ts.session_id) >= $2
      ORDER BY last_session_at DESC
    `, [todayStart, limits.max_sessions_per_day]);

    const rateLimitedUsers = result.rows.map(row => ({
      userid: row.userid,
      username: row.username,
      role: row.role,
      sessions_used_today: parseInt(row.sessions_today),
      session_limit: limits.max_sessions_per_day,
      limit_resets_at: getNextMidnightSLC().toISOString(),
      hours_until_reset: getHoursUntilReset(),
      last_session_at: row.last_session_at
    }));

    res.json({ rateLimitedUsers, config: limits });
  }));

  return router;
}
