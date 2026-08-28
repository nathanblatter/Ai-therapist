import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  insertNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  markNotificationsEmailed,
  getNotificationPreferences,
  upsertNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from './notifications.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('insertNotification / listNotifications', () => {
  it('inserts with defaults for optional fields', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ notification_id: 1 }] });
    await insertNotification({ userId: 7, kind: 'crisis_flag', title: 'Urgent item' });
    expect(queryMock.mock.calls[0][1]).toEqual([7, null, 'crisis_flag', 'Urgent item', null]);
  });

  it('unreadOnly adds the read_at IS NULL filter', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listNotifications(7, { unreadOnly: true, limit: 10 });
    expect(String(queryMock.mock.calls[0][0])).toContain('read_at IS NULL');
    expect(queryMock.mock.calls[0][1]).toEqual([7, 10]);
  });
});

describe('read state', () => {
  it('markNotificationRead is self-scoped by user_id', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(markNotificationRead(3, 7)).resolves.toBe(false);
    expect(String(queryMock.mock.calls[0][0])).toContain('user_id = $2');
    expect(queryMock.mock.calls[0][1]).toEqual([3, 7]);
  });

  it('markAllNotificationsRead returns the number updated', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 5, rows: [] });
    await expect(markAllNotificationsRead(7)).resolves.toBe(5);
  });

  it('countUnreadNotifications parses the count', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '2' }] });
    await expect(countUnreadNotifications(7)).resolves.toBe(2);
  });
});

describe('email bookkeeping', () => {
  it('markNotificationsEmailed no-ops on an empty list', async () => {
    await markNotificationsEmailed([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('preferences', () => {
  it('falls back to schema defaults when no row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getNotificationPreferences(7)).resolves.toEqual({
      user_id: 7,
      ...DEFAULT_NOTIFICATION_PREFERENCES,
    });
  });

  it('upsert merges partial updates over current values', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // getNotificationPreferences miss -> defaults
      .mockResolvedValueOnce({
        rows: [{ user_id: 7, email_mode: 'off', urgent_email_immediate: true, digest_hour_local: 8, in_app_enabled: true }],
      });
    const row = await upsertNotificationPreferences(7, { email_mode: 'off' });
    expect(row.email_mode).toBe('off');
    const params = queryMock.mock.calls[1][1] as unknown[];
    expect(params).toEqual([7, 'off', true, 8, true]);
    expect(String(queryMock.mock.calls[1][0])).toContain('ON CONFLICT (user_id) DO UPDATE');
  });
});
