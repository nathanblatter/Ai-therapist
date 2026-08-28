// Admin roster of rate-limited participants (therapist/researcher): who has hit
// the daily session cap today and when their limit resets.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { getNextMidnightSLC, getHoursUntilReset, getStartOfTodaySLC } from '../../utils/timezoneHelpers.js';
import { getRateLimitedParticipants } from '../../db/index.js';

import type { SessionLimits } from '../../../shared/systemConfig.js';

// This surface only makes sense with a configured cap, so narrow the shared
// (optional-field) blob type to require max_sessions_per_day, as the old
// local declaration did.
type RateLimitConfig = SessionLimits & { max_sessions_per_day: number };

export default function adminRateLimitsRoutes(): Router {
  const router = Router();

  // GET /admin/api/rate-limits/users - all currently rate-limited participants
  router.get('/admin/api/rate-limits/users', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const config = await getSystemConfig();
      const limits = (config.session_limits as RateLimitConfig | undefined) ?? { enabled: false, max_sessions_per_day: 0 };

      if (!limits.enabled) {
        return res.json({ rateLimitedUsers: [], config: limits });
      }

      const rows = await getRateLimitedParticipants(getStartOfTodaySLC(), limits.max_sessions_per_day);
      const rateLimitedUsers = rows.map(row => ({
        userid: row.userid,
        username: row.username,
        role: row.role,
        sessions_used_today: parseInt(row.sessions_today),
        session_limit: limits.max_sessions_per_day,
        limit_resets_at: getNextMidnightSLC().toISOString(),
        hours_until_reset: getHoursUntilReset(),
        last_session_at: row.last_session_at,
      }));

      res.json({ rateLimitedUsers, config: limits });
    } catch (err) {
      console.error('Error fetching rate-limited users:', err);
      res.status(500).json({ error: 'Failed to fetch rate-limited users' });
    }
  });

  return router;
}
