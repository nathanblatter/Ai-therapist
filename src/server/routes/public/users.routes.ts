// User management + per-user preferences (under /api/users).
// Researcher-gated where noted; preferences/self routes only need auth.
import { Router, type Request } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { passwordPolicyError } from '../../utils/passwordPolicy.js';
import { registerAccount, updateAccount, removeAccount, resetAuthenticator } from '../../services/accounts.service.js';
import {
  setAccountEmail,
  validateAccountEmail,
  provisionStudyAddress,
  EmailAccountError,
} from '../../services/researcherEmail.service.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import {
  getAllUsers,
  getUserById,
  insertAccountAudit,
  listAccountAudit,
  type AccountAuditAction,
  getUserPreferences,
  updateUserPreferences,
  setUserPreferredTheme,
  type UserRow,
  type VoicesConfig,
  type LanguagesConfig,
} from '../../db/index.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('usersRoutes');

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

/**
 * The account a request may act on by id, or null (answer 404). A researcher
 * reaches the accounts of their own organisation and no others: the same
 * reach as the user list (GET /api/users). Before 2026-11-26 the by-id routes
 * checked the role only, so a researcher in one organisation could read,
 * re-password, re-role or delete an account in another by guessing its id.
 * Acting on your own account is always in reach. "Not found" and "not yours"
 * get the same answer, so ids in other organisations cannot be probed.
 */
async function accountInReach(req: Request, userid: string): Promise<UserRow | null> {
  const target = await getUserById(userid);
  if (!target) return null;
  if (target.userid === req.session.userId) return target;
  const callerOrg = await orgIdFor(req);
  if (callerOrg === null || target.organization_id !== callerOrg) {
    log.warn(
      { by: req.session.userId, target: target.userid, method: req.method },
      'account access across organisations refused',
    );
    return null;
  }
  return target;
}

/** Record an account change in the audit trail (migration 132), with the
 *  signed-in person as the actor. Never throws. */
function audit(
  req: Request,
  action: AccountAuditAction,
  target: { userid?: number | null; username?: string | null; organization_id?: number | null },
  detail?: Record<string, unknown>,
): Promise<void> {
  return insertAccountAudit({
    action,
    targetUserId: typeof target.userid === 'number' ? target.userid : null,
    targetUsername: target.username ?? null,
    organizationId: target.organization_id ?? req.session.orgId ?? null,
    actorUserId: req.session.userId ?? null,
    actorUsername: req.session.username ?? null,
    detail,
  });
}

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
      log.error({ err: error }, 'Error fetching users');
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // GET /api/users/audit - the account audit trail of the researcher's own
  // organisation, newest first (migration 132). Registered before
  // /api/users/:userid so "audit" is not read as an id.
  router.get('/api/users/audit', requireRole('researcher'), async (req, res) => {
    try {
      const orgId = await orgIdFor(req);
      if (orgId === null) return res.json({ audit: [], available: true });
      const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
      const rows = await listAccountAudit(orgId, Number.isFinite(limit) ? limit : 200);
      // null: this database has no audit table yet. Say so; an empty list
      // would read as "nothing has changed".
      res.json({ audit: rows ?? [], available: rows !== null });
    } catch (error) {
      log.error({ err: error }, 'Error reading the account audit trail');
      res.status(500).json({ error: 'Failed to read the account audit trail' });
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
      const theme =
        prefs?.preferred_theme && VALID_THEMES.includes(prefs.preferred_theme) ? prefs.preferred_theme : null;

      res.json({ voice, language, theme, memory_enabled });
    } catch (error) {
      log.error({ err: error }, 'Error fetching user preferences');
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
      log.error({ err: error }, 'Error saving memory preference');
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
      log.error({ err: error }, 'Error saving theme preference');
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
      log.error({ err: error }, 'Error saving user preferences');
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
      const user = await accountInReach(req, userid);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user });
    } catch (error) {
      log.error({ err: error }, 'Error fetching user');
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // PUT /api/users/:userid - researcher, or self (self can't change role)
  router.put('/api/users/:userid', requireAuth, async (req, res) => {
    const { userid } = req.params;
    const requestingUserId = req.session.userId;
    const requestingUserRole = req.session.userRole;
    const { username, password, role, email } = req.body;

    const isSelf = parseInt(userid) === requestingUserId;
    const isResearcher = requestingUserRole === 'researcher';

    if (!isSelf && !isResearcher) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    if (!isResearcher && role !== undefined) {
      return res.status(403).json({ error: 'Only researchers can change user roles' });
    }
    // Staff email (ai-therapist-283): admin-managed, researcher-only, and the
    // service refuses it for participants whoever asks.
    if (email !== undefined && !isResearcher) {
      return res.status(403).json({ error: 'Only researchers can change email addresses' });
    }
    if (email !== undefined && email !== null && typeof email !== 'string') {
      return res.status(400).json({ error: 'Invalid email address' });
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
      // The row before the change: who may be reached, and what the audit
      // trail records as "from".
      const before = await accountInReach(req, userid);
      if (!before) {
        return res.status(404).json({ error: 'User not found' });
      }
      const updates: UserUpdates = {};
      if (username !== undefined) updates.username = username;
      if (password !== undefined) updates.password = password;
      if (role !== undefined && isResearcher) updates.role = role;

      if (Object.keys(updates).length === 0 && email === undefined) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      // The email is checked (eligibility against the role this edit will
      // leave, shape, uniqueness) BEFORE anything is written, so a rejected
      // address never leaves a half-applied edit behind.
      if (email !== undefined) await validateAccountEmail(userid, email, updates.role);

      // What the audit trail records for this edit: only what actually changed
      // (the form sends the role and username with every save), never the
      // password or the address themselves, and each step as it completes.
      const self = isSelf ? { self: true } : {};
      const target = { userid: before.userid, username: before.username, organization_id: before.organization_id };
      const auditAccountChanges = async (extra: Record<string, unknown>) => {
        if (updates.role !== undefined && updates.role !== before.role) {
          await audit(req, 'role_changed', target, { from: before.role, to: updates.role, ...extra });
        }
        if (updates.username !== undefined && updates.username !== before.username) {
          await audit(req, 'username_changed', target, {
            from: before.username,
            to: updates.username,
            ...self,
            ...extra,
          });
        }
        if (updates.password !== undefined) await audit(req, 'password_changed', target, { ...self, ...extra });
      };

      let updatedUser = null;
      if (Object.keys(updates).length > 0) {
        try {
          updatedUser = await updateAccount(userid, updates);
        } catch (updateErr) {
          // The local row changed; only the sign-in service did not follow.
          // That is still a change to this account, and it is recorded.
          if (updateErr instanceof Error && updateErr.name === 'AccountSyncError') {
            await auditAccountChanges({ signInServiceSynced: false });
          }
          throw updateErr;
        }
        await auditAccountChanges({});
      }
      if (email !== undefined) {
        const withEmail = await setAccountEmail(userid, email);
        updatedUser = updatedUser ? { ...updatedUser, email: withEmail.email } : withEmail;
        log.info(
          { userid, by: requestingUserId, email: withEmail.email ?? null },
          'account email address changed by a researcher',
        );
        if ((withEmail.email ?? null) !== (before.email ?? null)) {
          await audit(req, 'email_changed', target, { set: Boolean(withEmail.email) });
        }
      }
      if (!updatedUser) {
        // Unreachable (the empty-update guard above), kept for the type.
        return res.status(400).json({ error: 'No fields to update' });
      }

      if (isSelf) {
        if (updates.username) req.session.username = updatedUser.username;
        if (updates.role) req.session.userRole = updatedUser.role;
      }

      res.json({ success: true, user: updatedUser });
    } catch (error: unknown) {
      if (error instanceof EmailAccountError) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error instanceof Error && error.message === 'Username already exists') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      if (error instanceof Error && error.message === 'Email already in use') {
        return res.status(409).json({ error: 'Email already in use' });
      }
      if (error instanceof Error && error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      if (error instanceof Error && error.message === 'Username cannot be changed') {
        return res
          .status(409)
          .json({ error: 'Usernames cannot change once the account exists in the sign-in service' });
      }
      if (error instanceof Error && error.name === 'AccountSyncError') {
        // 400 when the provider refused the password itself, 502 otherwise.
        const refused = (error as { code?: string }).code === 'password_rejected';
        return res.status(refused ? 400 : 502).json({ error: error.message });
      }
      log.error({ err: error }, 'Error updating user');
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // DELETE /api/users/:userid - researcher only
  // Give a staff account its study address, <slug>@byuisresearch.com
  // (ai-therapist-283 phase 1). Idempotent; participants are refused.
  router.post('/api/users/:userid/provision-email', requireRole('researcher'), async (req, res) => {
    try {
      const before = await accountInReach(req, req.params.userid);
      if (!before) {
        return res.status(404).json({ error: 'User not found' });
      }
      const { user, address } = await provisionStudyAddress(req.params.userid);
      log.info({ userid: user.userid, by: req.session.userId, address }, 'study email address provisioned');
      // Idempotent: an account that already had this address did not change.
      if ((before.email ?? null) !== address) {
        await audit(req, 'email_changed', before, { set: true, provisioned: true });
      }
      res.json({
        success: true,
        email: address,
        user: { userid: user.userid, username: user.username, role: user.role },
      });
    } catch (error: unknown) {
      if (error instanceof EmailAccountError) {
        return res.status(error.status).json({ error: error.message });
      }
      log.error({ err: error }, 'Error provisioning a study email address');
      res.status(500).json({ error: 'Failed to provision email address' });
    }
  });

  // A staff member lost their authenticator app: switch the code challenge
  // off in the sign-in service so their next sign-in enrols a new one
  // (ai-therapist-396). Cognito deployments only.
  router.post('/api/users/:userid/reset-authenticator', requireRole('researcher'), async (req, res) => {
    // A reset opens an account to whoever knows its password until the owner
    // enrols again, so this is not a request another site may make for a
    // signed-in researcher: a cross-site form cannot send JSON.
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Send this request as JSON' });
    }
    try {
      // Same reach as the user list: accounts in the researcher's own organisation.
      const target = await accountInReach(req, req.params.userid);
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      const user = await resetAuthenticator(req.params.userid);
      await audit(req, 'authenticator_reset', target, { role: target.role });
      log.warn(
        { userid: user.userid, username: user.username, by: req.session.userId, byUsername: req.session.username },
        'authenticator app reset by a researcher',
      );
      res.json({ success: true, user: { userid: user.userid, username: user.username, role: user.role } });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      if (error instanceof Error && error.name === 'AccountSyncError') {
        const notStaff = (error as { code?: string }).code === 'not_staff';
        return res.status(notStaff ? 400 : 502).json({ error: error.message });
      }
      log.error({ err: error }, 'Error resetting an authenticator app');
      res.status(500).json({ error: 'Failed to reset the authenticator app' });
    }
  });

  router.delete('/api/users/:userid', requireRole('researcher'), async (req, res) => {
    const { userid } = req.params;
    try {
      const target = await accountInReach(req, userid);
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Recorded before the pool call can fail: the local row is gone either way.
      let deletedUser;
      try {
        deletedUser = await removeAccount(userid);
      } catch (removeErr) {
        if (removeErr instanceof Error && removeErr.name === 'AccountSyncError') {
          await audit(req, 'account_deleted', target, { role: target.role, signInServiceRemoved: false });
        }
        throw removeErr;
      }
      await audit(req, 'account_deleted', target, { role: target.role });
      res.json({ success: true, message: `User ${deletedUser.username} deleted successfully` });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      // The row is gone but the provider kept the sign-in: say so.
      if (error instanceof Error && error.name === 'AccountSyncError') {
        return res.status(502).json({ error: error.message });
      }
      log.error({ err: error }, 'Error deleting user');
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
      const user = await registerAccount(username, password, role);
      await audit(req, 'account_created', user, { role: user.role, via: 'user_management' });
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
      if (error instanceof Error && error.name === 'AccountSyncError') {
        // 400 when the provider refused the password itself, 502 otherwise.
        const refused = (error as { code?: string }).code === 'password_rejected';
        return res.status(refused ? 400 : 502).json({ error: error.message });
      }
      log.error({ err: error }, 'User creation error');
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  return router;
}
