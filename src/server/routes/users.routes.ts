import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireRole, getAllUsers, getUserById, updateUser, deleteUser, createUser } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSystemConfig } from '../utils/sessionHelpers.js';
import { getNextMidnightSLC, getHoursUntilReset } from '../utils/timezoneHelpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('users');

export default function usersRoutes() {
  const router = Router();

  // GET /api/rate-limits/status
  router.get('/api/rate-limits/status', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const userRole = req.session.userRole;

    if (userRole === 'researcher') {
      return res.json({
        is_rate_limited: false,
        is_exempt: true,
        exemption_reason: 'researcher'
      });
    }

    const config = await getSystemConfig();
    const limits = config.session_limits || { enabled: false };

    if (!limits.enabled) {
      return res.json({ is_rate_limited: false, is_exempt: true, exemption_reason: 'limits_disabled' });
    }

    const todayStart = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
    todayStart.setHours(0, 0, 0, 0);

    const result = await pool.query(`
      SELECT COUNT(*) as session_count, MAX(created_at) as last_session_at
      FROM therapy_sessions
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, todayStart]);

    const sessionsToday = parseInt(result.rows[0].session_count);
    const isRateLimited = sessionsToday >= limits.max_sessions_per_day;

    res.json({
      is_rate_limited: isRateLimited,
      sessions_used_today: sessionsToday,
      session_limit: limits.max_sessions_per_day,
      limit_resets_at: getNextMidnightSLC().toISOString(),
      hours_until_reset: getHoursUntilReset(),
      last_session_at: result.rows[0].last_session_at,
      is_exempt: false,
      exemption_reason: null
    });
  }));

  // GET /api/users
  router.get("/api/users", requireRole('researcher'), asyncHandler(async (req, res) => {
    const users = await getAllUsers();
    res.json({ users });
  }));

  // GET /api/users/preferences
  router.get("/api/users/preferences", requireAuth, asyncHandler(async (req, res) => {
    const userId = req.session.userId;

    const result = await pool.query(
      'SELECT preferred_voice, preferred_language FROM users WHERE userid = $1',
      [userId]
    );

    const config = await getSystemConfig();
    const voicesConfig = config.voices || {
      voices: [{ value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }],
      default_voice: 'cedar'
    };
    const languagesConfig = config.languages || {
      languages: [{ value: 'en', label: 'English', description: 'English', enabled: true }],
      default_language: 'en'
    };

    let voice = voicesConfig.default_voice;
    let language = languagesConfig.default_language;

    if (result.rows.length > 0) {
      const userVoice = result.rows[0].preferred_voice;
      const userLanguage = result.rows[0].preferred_language;

      const voiceEnabled = voicesConfig.voices
        ? voicesConfig.voices.find(v => v.value === userVoice && v.enabled)
        : null;
      const languageEnabled = languagesConfig.languages
        ? languagesConfig.languages.find(l => l.value === userLanguage && l.enabled)
        : null;

      voice = voiceEnabled ? userVoice : voicesConfig.default_voice;
      language = languageEnabled ? userLanguage : languagesConfig.default_language;

      if (userVoice && !voiceEnabled) {
        log.info(`User ${userId} preferred voice '${userVoice}' is disabled, falling back to '${voice}'`);
      }
      if (userLanguage && !languageEnabled) {
        log.info(`User ${userId} preferred language '${userLanguage}' is disabled, falling back to '${language}'`);
      }
    }

    res.json({ voice, language });
  }));

  // PUT /api/users/preferences
  router.put("/api/users/preferences", requireAuth, asyncHandler(async (req, res) => {
    const userId = req.session.userId;
    const { voice, language } = req.body;

    if (!voice || !language) {
      return res.status(400).json({ error: 'Voice and language are required' });
    }

    const config = await getSystemConfig();
    const voicesConfig = config.voices || {
      voices: [{ value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }],
      default_voice: 'cedar'
    };
    const languagesConfig = config.languages || {
      languages: [{ value: 'en', label: 'English', description: 'English', enabled: true }],
      default_language: 'en'
    };

    const voiceEnabled = voicesConfig.voices
      ? voicesConfig.voices.find(v => v.value === voice && v.enabled)
      : null;
    const languageEnabled = languagesConfig.languages
      ? languagesConfig.languages.find(l => l.value === language && l.enabled)
      : null;

    if (!voiceEnabled) {
      return res.status(400).json({ error: `Voice '${voice}' is not available` });
    }
    if (!languageEnabled) {
      return res.status(400).json({ error: `Language '${language}' is not available` });
    }

    await pool.query(
      'UPDATE users SET preferred_voice = $1, preferred_language = $2 WHERE userid = $3',
      [voice, language, userId]
    );

    log.info(`Updated preferences for user ${userId}: voice=${voice}, language=${language}`);

    res.json({ success: true, voice, language });
  }));

  // GET /api/users/:userid
  router.get("/api/users/:userid", requireAuth, asyncHandler(async (req, res) => {
    const { userid } = req.params;
    const requestingUserId = req.session.userId;
    const requestingUserRole = req.session.userRole;

    if (requestingUserRole !== 'researcher' && parseInt(userid) !== requestingUserId) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const user = await getUserById(userid);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  }));

  // PUT /api/users/:userid
  router.put("/api/users/:userid", requireAuth, asyncHandler(async (req, res) => {
    const { userid } = req.params;
    const requestingUserId = req.session.userId;
    const requestingUserRole = req.session.userRole;
    const { username, password, role } = req.body;

    const isSelf = parseInt(userid) === requestingUserId;
    const isResearcher = requestingUserRole === 'researcher';

    if (!isSelf && !isResearcher) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    if (!isResearcher && role !== undefined) {
      return res.status(403).json({ error: 'Only researchers can change user roles' });
    }

    const updates = {};
    if (username !== undefined) updates.username = username;
    if (password !== undefined) updates.password = password;
    if (role !== undefined && isResearcher) updates.role = role;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    try {
      const updatedUser = await updateUser(userid, updates);

      if (isSelf) {
        if (updates.username) req.session.username = updatedUser.username;
        if (updates.role) req.session.userRole = updatedUser.role;
      }

      res.json({ success: true, user: updatedUser });
    } catch (error) {
      if (error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      if (error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      throw error;
    }
  }));

  // DELETE /api/users/:userid
  router.delete("/api/users/:userid", requireRole('researcher'), asyncHandler(async (req, res) => {
    const { userid } = req.params;

    try {
      const deletedUser = await deleteUser(userid);
      res.json({
        success: true,
        message: `User ${deletedUser.username} deleted successfully`
      });
    } catch (error) {
      if (error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      throw error;
    }
  }));

  // POST /api/users
  router.post("/api/users", requireRole('researcher'), asyncHandler(async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }

    if (!['therapist', 'researcher', 'participant'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    try {
      const user = await createUser(username, password, role);
      res.json({
        success: true,
        user: { userid: user.userid, username: user.username, role: user.role }
      });
    } catch (error) {
      if (error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      throw error;
    }
  }));

  return router;
}
