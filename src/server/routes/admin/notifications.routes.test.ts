// Notification API tests: strict self-scoping (session user id is the only
// scope every query receives) and preference validation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  countUnreadNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  getNotificationPreferences: vi.fn(),
  upsertNotificationPreferences: vi.fn(),
}));
vi.mock('../../db/index.js', () => dbMocks);

import notificationsRoutes from './notifications.routes.js';

function appAs(role: string | null, userId = 9) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = role
      ? { userId, userRole: role, username: 'tester' }
      : {};
    next();
  });
  app.use(notificationsRoutes());
  return app;
}

const PREFS = {
  user_id: 9, email_mode: 'digest', urgent_email_immediate: true,
  digest_hour_local: 8, in_app_enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.listNotifications.mockResolvedValue([
    { notification_id: 1, user_id: 9, kind: 'crisis_flag', title: 'x', read_at: null },
  ]);
  dbMocks.countUnreadNotifications.mockResolvedValue(3);
  dbMocks.markNotificationRead.mockResolvedValue(true);
  dbMocks.markAllNotificationsRead.mockResolvedValue(3);
  dbMocks.getNotificationPreferences.mockResolvedValue(PREFS);
  dbMocks.upsertNotificationPreferences.mockResolvedValue({ ...PREFS, email_mode: 'immediate' });
});

describe('GET /admin/api/notifications', () => {
  it('returns the session user notifications plus the unread count', async () => {
    const res = await request(appAs('caseworker', 9)).get('/admin/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.unread_count).toBe(3);
    expect(dbMocks.listNotifications).toHaveBeenCalledWith(9, { unreadOnly: false, limit: 50 });
  });

  it('supports unread_only and limit', async () => {
    await request(appAs('therapist', 7)).get('/admin/api/notifications?unread_only=1&limit=5');
    expect(dbMocks.listNotifications).toHaveBeenCalledWith(7, { unreadOnly: true, limit: 5 });
  });

  it('requires authentication', async () => {
    expect((await request(appAs(null)).get('/admin/api/notifications')).status).toBe(401);
  });
});

describe('POST read endpoints', () => {
  it('marks one notification read, scoped to the session user', async () => {
    const res = await request(appAs('caseworker', 9)).post('/admin/api/notifications/12/read');
    expect(res.status).toBe(200);
    expect(dbMocks.markNotificationRead).toHaveBeenCalledWith(12, 9);
  });

  it('404s when the row does not belong to the user (or is already read)', async () => {
    dbMocks.markNotificationRead.mockResolvedValue(false);
    expect((await request(appAs('caseworker', 9)).post('/admin/api/notifications/12/read')).status).toBe(404);
  });

  it('400s on a non-numeric id', async () => {
    expect((await request(appAs('caseworker', 9)).post('/admin/api/notifications/abc/read')).status).toBe(400);
  });

  it('marks all read', async () => {
    const res = await request(appAs('caseworker', 9)).post('/admin/api/notifications/read-all');
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
    expect(dbMocks.markAllNotificationsRead).toHaveBeenCalledWith(9);
  });
});

describe('notification preferences', () => {
  it('returns the user preferences', async () => {
    const res = await request(appAs('caseworker', 9)).get('/admin/api/notifications/preferences');
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject({ email_mode: 'digest' });
  });

  it('updates valid preferences', async () => {
    const res = await request(appAs('caseworker', 9))
      .put('/admin/api/notifications/preferences')
      .send({ email_mode: 'immediate', digest_hour_local: 7 });
    expect(res.status).toBe(200);
    expect(dbMocks.upsertNotificationPreferences).toHaveBeenCalledWith(9, {
      email_mode: 'immediate', digest_hour_local: 7,
    });
  });

  it.each([
    [{ email_mode: 'hourly' }],
    [{ digest_hour_local: 24 }],
    [{ digest_hour_local: -1 }],
    [{ urgent_email_immediate: 'yes' }],
    [{ in_app_enabled: 1 }],
  ])('rejects invalid preferences %j with 400', async (body) => {
    const res = await request(appAs('caseworker', 9))
      .put('/admin/api/notifications/preferences')
      .send(body);
    expect(res.status).toBe(400);
    expect(dbMocks.upsertNotificationPreferences).not.toHaveBeenCalled();
  });
});
