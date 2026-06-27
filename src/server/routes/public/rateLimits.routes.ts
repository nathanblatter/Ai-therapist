// Per-user rate-limit status (any authenticated user). Tells the client whether
// they've hit the daily session cap and when it resets.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { getNextMidnightSLC, getHoursUntilReset, getStartOfTodaySLC } from '../../utils/timezoneHelpers.js';
import { getSessionsToday } from '../../db/index.js';

interface SessionLimits {
  enabled: boolean;
  max_sessions_per_day: number;
}

export default function rateLimitsRoutes(): Router {
  const router = Router();

  // GET /api/rate-limits/status - current user's rate limit status
  router.get('/api/rate-limits/status', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const userRole = req.session.userRole;

      // Researchers are exempt from limits.
      if (userRole === 'researcher') {
        return res.json({ is_rate_limited: false, is_exempt: true, exemption_reason: 'researcher' });
      }

      const config = await getSystemConfig();
      const limits = (config.session_limits as SessionLimits | undefined) ?? { enabled: false, max_sessions_per_day: 0 };

      if (!limits.enabled) {
        return res.json({ is_rate_limited: false, is_exempt: true, exemption_reason: 'limits_disabled' });
      }

      const row = await getSessionsToday(userId, getStartOfTodaySLC());
      const sessionsToday = parseInt(row.session_count);
      const isRateLimited = sessionsToday >= limits.max_sessions_per_day;

      res.json({
        is_rate_limited: isRateLimited,
        sessions_used_today: sessionsToday,
        session_limit: limits.max_sessions_per_day,
        limit_resets_at: getNextMidnightSLC().toISOString(),
        hours_until_reset: getHoursUntilReset(),
        last_session_at: row.last_session_at,
        is_exempt: false,
        exemption_reason: null,
      });
    } catch (err) {
      console.error('Error fetching rate limit status:', err);
      res.status(500).json({ error: 'Failed to fetch rate limit status' });
    }
  });

  return router;
}
