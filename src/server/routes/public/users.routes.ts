// User management + per-user preferences (under /api/users).
// Researcher-gated where noted; preferences/self routes only need auth.
import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { passwordPolicyError } from '../../utils/passwordPolicy.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import {
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  createUser,
  getUserPreferences,
  updateUserPreferences,
  setUserPreferredTheme,
  type VoicesConfig,
  type LanguagesConfig,
} from '../../db/index.js';

interface UserUpdates {
  username?: string;
  password?: string;
  role?: string;
}

const DEFAULT_VOICES: VoicesConfig = {
  voices: [{ value: 'cedar', label: 'Cedar', description: 'Warm & natural', enabled: true }],
  default_voice: 'cedar',
};
const DEFAULT_LANGUAGES: LanguagesConfig = {
  languages: [{ value: 'en', label: 'English', description: 'English', enabled: true }],
  default_language: 'en',
};

// Must match THEMES in src/client/shared/theme.ts.
const VALID_THEMES = ['default', 'sage', 'ocean', 'dusk', 'dark'];

// Assignable roles (same list POST /api/users and /api/auth/register enforce).
// 'demo' is deliberately absent — demo accounts are only minted by the magic
// link, and an arbitrary role string would corrupt every role-keyed gate.
const VALID_ROLES = ['therapist', 'researcher', 'participant', 'caseworker'];

export default function usersRoutes(): Router {
  const router = Router();

  // Defense-in-depth for demo isolation: the demo interceptor (demo.routes.ts)
  // should swallow every /api/users write for 'demo' accounts before it ever
  // reaches this router, but if a path variant slips past it, reject writes
  // here too (same swallow shape the interceptor uses, so the demo UI behaves
  // identically). Preference writes stay real for demo accounts on purpose.
  router.use('/api/users', (req, res, next) => {
    if (req.method === 'GET') return next();
    if (req.session?.userRole !== 'demo') return next();
    if (/^\/preferences(\/|$)/i.test(req.path)) return next();
    return res.json({ success: true, demo: true, message: 'Demo mode — changes are not saved.' });
  });

  // GET /api/users - all users (researcher only, org-scoped per C13; at
  // cutover every user is in irb-study so results are byte-identical)
  router.get('/api/users', requireRole('researcher'), async (req, res) => {
    try {
      const users = await getAllUsers(null, await orgIdFor(req));
      res.json({ users });
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // --- Preferences (must be registered before /api/users/:userid) ---

  // GET /api/users/preferences - current user's voice/language (falling back if disabled)
  router.get('/api/users/preferences', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    try {
      const prefs = await getUserPreferences(userId!);

      const config = await getSystemConfig();
      const voicesConfig = (config.voices as VoicesConfig | undefined) ?? DEFAULT_VOICES;
      const languagesConfig = (config.languages as LanguagesConfig | undefined) ?? DEFAULT_LANGUAGES;

      let voice = voicesConfig.default_voice;
      let language = languagesConfig.default_language;

      if (prefs) {
        const userVoice = prefs.preferred_voice;
        const userLanguage = prefs.preferred_language;

        const voiceEnabled = voicesConfig.voices?.find((v) => v.value === userVoice && v.enabled);
        const languageEnabled = languagesConfig.languages?.find((l) => l.value === userLanguage && l.enabled);

        voice = voiceEnabled ? userVoice! : voicesConfig.default_voice;
        language = languageEnabled ? userLanguage! : languagesConfig.default_language;
      }

      const { getUserMemoryEnabled } = await import('../../db/index.js');
      const memory_enabled = await getUserMemoryEnabled(userId!);

      // null = never chosen (distinct from an explicit 'default' choice, which
      // should sync across devices).
      const theme = prefs?.preferred_theme && VALID_THEMES.includes(prefs.preferred_theme)
        ? prefs.preferred_theme
        : null;

      res.json({ voice, language, theme, memory_enabled });
    } catch (error) {
      console.error('Error fetching user preferences:', error);
      res.status(500).json({ error: 'Failed to fetch preferences' });
    }
  });

  // PUT /api/users/preferences/memory - cross-session memory consent (opt-in)
  router.put('/api/users/preferences/memory', requireAuth, async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    try {
      const { setUserMemoryEnabled } = await import('../../db/index.js');
      await setUserMemoryEnabled(req.session.userId!, enabled);
      res.json({ success: true, memory_enabled: enabled });
    } catch (error) {
      console.error('Error saving memory preference:', error);
      res.status(500).json({ error: 'Failed to save memory preference' });
    }
  });

  // PUT /api/users/preferences/theme - UI theme preset
  router.put('/api/users/preferences/theme', requireAuth, async (req, res) => {
    const { theme } = req.body;
    if (typeof theme !== 'string' || !VALID_THEMES.includes(theme)) {
      return res.status(400).json({ error: `theme must be one of: ${VALID_THEMES.join(', ')}` });
    }
    try {
      await setUserPreferredTheme(req.session.userId!, theme);
      res.json({ success: true, theme });
    } catch (error) {
      console.error('Error saving theme preference:', error);
      res.status(500).json({ error: 'Failed to save theme preference' });
    }
  });

  // PUT /api/users/preferences - save preferences (validated against enabled options)
  router.put('/api/users/preferences', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const { voice, language } = req.body;

    if (!voice || !language) {
      return res.status(400).json({ error: 'Voice and language are required' });
    }

    try {
      const config = await getSystemConfig();
      const voicesConfig = (config.voices as VoicesConfig | undefined) ?? DEFAULT_VOICES;
      const languagesConfig = (config.languages as LanguagesConfig | undefined) ?? DEFAULT_LANGUAGES;

      if (!voicesConfig.voices?.find((v) => v.value === voice && v.enabled)) {
        return res.status(400).json({ error: `Voice '${voice}' is not available` });
      }
      if (!languagesConfig.languages?.find((l) => l.value === language && l.enabled)) {
        return res.status(400).json({ error: `Language '${language}' is not available` });
      }

      await updateUserPreferences(userId!, voice, language);
      res.json({ success: true, voice, language });
    } catch (error) {
      console.error('Error saving user preferences:', error);
      res.status(500).json({ error: 'Failed to save preferences' });
    }
  });

  // GET /api/users/:userid - researcher, or self
  router.get('/api/users/:userid', requireAuth, async (req, res) => {
    const { userid } = req.params;
    const requestingUserId = req.session.userId;
    const requestingUserRole = req.session.userRole;

    if (requestingUserRole !== 'researcher' && parseInt(userid) !== requestingUserId) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    try {
      const user = await getUserById(userid);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user });
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // PUT /api/users/:userid - researcher, or self (self can't change role)
  router.put('/api/users/:userid', requireAuth, async (req, res) => {
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
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (password !== undefined) {
      const pwError = passwordPolicyError(password);
      if (pwError) {
        return res.status(400).json({ error: pwError });
      }
    }

    try {
      const updates: UserUpdates = {};
      if (username !== undefined) updates.username = username;
      if (password !== undefined) updates.password = password;
      if (role !== undefined && isResearcher) updates.role = role;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      const updatedUser = await updateUser(userid, updates as Record<string, string>);

      if (isSelf) {
        if (updates.username) req.session.username = updatedUser.username;
        if (updates.role) req.session.userRole = updatedUser.role;
      }

      res.json({ success: true, user: updatedUser });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      if (error instanceof Error && error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      console.error('Error updating user:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // DELETE /api/users/:userid - researcher only
  router.delete('/api/users/:userid', requireRole('researcher'), async (req, res) => {
    const { userid } = req.params;
    try {
      const deletedUser = await deleteUser(userid);
      res.json({ success: true, message: `User ${deletedUser.username} deleted successfully` });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // POST /api/users - create user (researcher only)
  router.post('/api/users', requireRole('researcher'), async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Username, password, and role are required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const pwError = passwordPolicyError(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    try {
      const user = await createUser(username, password, role);
      res.json({ success: true, user: { userid: user.userid, username: user.username, role: user.role } });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      // Name check (not instanceof): route tests mock db/index.js wholesale,
      // which would leave the class binding undefined.
      if (error instanceof Error && error.name === 'ResearchOrgCaseworkerError') {
        return res.status(400).json({ error: error.message });
      }
      console.error('User creation error:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  return router;
}
