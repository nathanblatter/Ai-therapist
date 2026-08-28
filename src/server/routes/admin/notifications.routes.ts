// In-app notification API (caseworker portal, spec section 3). Every row is
// strictly self-scoped by session user id — the queries carry the user_id
// guard, so there is no cross-user surface to protect beyond requireAuth.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  upsertNotificationPreferences,
  type NotificationPreferencesRow,
} from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { parsePagination } from '../../utils/pagination.js';

const log = createLogger('notificationsRoutes');

const EMAIL_MODES = ['immediate', 'digest', 'off'] as const;

function validatePreferences(body: unknown):
  { ok: true; prefs: Partial<Omit<NotificationPreferencesRow, 'user_id'>> } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
  const input = body as Record<string, unknown>;
  const prefs: Partial<Omit<NotificationPreferencesRow, 'user_id'>> = {};

  if (input.email_mode !== undefined) {
    if (!EMAIL_MODES.includes(input.email_mode as (typeof EMAIL_MODES)[number])) {
      return { ok: false, error: 'Invalid email_mode' };
    }
    prefs.email_mode = input.email_mode as NotificationPreferencesRow['email_mode'];
  }
  if (input.urgent_email_immediate !== undefined) {
    if (typeof input.urgent_email_immediate !== 'boolean') {
      return { ok: false, error: 'Invalid urgent_email_immediate' };
    }
    prefs.urgent_email_immediate = input.urgent_email_immediate;
  }
  if (input.digest_hour_local !== undefined) {
    const hour = Number(input.digest_hour_local);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { ok: false, error: 'Invalid digest_hour_local' };
    }
    prefs.digest_hour_local = hour;
  }
  if (input.in_app_enabled !== undefined) {
    if (typeof input.in_app_enabled !== 'boolean') {
      return { ok: false, error: 'Invalid in_app_enabled' };
    }
    prefs.in_app_enabled = input.in_app_enabled;
  }
  return { ok: true, prefs };
}

export default function notificationsRoutes(): Router {
  const router = Router();

  // GET /admin/api/notifications?unread_only=1&limit=50
  router.get('/admin/api/notifications', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const unreadOnly = req.query.unread_only === '1' || req.query.unread_only === 'true';
      const { limit } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
      const [notifications, unreadCount] = await Promise.all([
        listNotifications(userId, { unreadOnly, limit }),
        countUnreadNotifications(userId),
      ]);
      res.json({ notifications, unread_count: unreadCount });
    } catch (err) {
      log.error({ err }, 'Failed to list notifications');
      res.status(500).json({ error: 'Failed to list notifications' });
    }
  });

  // POST /admin/api/notifications/read-all
  router.post('/admin/api/notifications/read-all', requireAuth, async (req, res) => {
    try {
      const updated = await markAllNotificationsRead(req.session.userId!);
      res.json({ success: true, updated });
    } catch (err) {
      log.error({ err }, 'Failed to mark all notifications read');
      res.status(500).json({ error: 'Failed to mark notifications read' });
    }
  });

  // POST /admin/api/notifications/:notificationId/read
  router.post('/admin/api/notifications/:notificationId/read', requireAuth, async (req, res) => {
    const notificationId = Number(req.params.notificationId);
    if (!Number.isInteger(notificationId)) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }
    try {
      const matched = await markNotificationRead(notificationId, req.session.userId!);
      if (!matched) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) {
      log.error({ err, notificationId }, 'Failed to mark notification read');
      res.status(500).json({ error: 'Failed to mark notification read' });
    }
  });

  // GET /admin/api/notifications/preferences
  router.get('/admin/api/notifications/preferences', requireAuth, async (req, res) => {
    try {
      const preferences = await getNotificationPreferences(req.session.userId!);
      res.json({ preferences });
    } catch (err) {
      log.error({ err }, 'Failed to fetch notification preferences');
      res.status(500).json({ error: 'Failed to fetch notification preferences' });
    }
  });

  // PUT /admin/api/notifications/preferences
  router.put('/admin/api/notifications/preferences', requireAuth, async (req, res) => {
    const validated = validatePreferences(req.body);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    try {
      const preferences = await upsertNotificationPreferences(req.session.userId!, validated.prefs);
      res.json({ preferences });
    } catch (err) {
      log.error({ err }, 'Failed to update notification preferences');
      res.status(500).json({ error: 'Failed to update notification preferences' });
    }
  });

  return router;
}
