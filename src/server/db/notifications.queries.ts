// Data-access for notifications + notification_preferences (caseworker
// portal, migration 074). Rows are strictly self-scoped by user_id; every
// mutating query carries the user_id guard so a route can never mark another
// user's notification.
import { pool } from '../config/db.js';

export interface NotificationRow {
  notification_id: number;
  user_id: number;
  work_item_id: number | null;
  kind: string;
  title: string;
  body: string | null;
  read_at: string | null;
  emailed_at: string | null;
  created_at: string;
}

const NOTIFICATION_COLUMNS = `notification_id, user_id, work_item_id, kind, title, body,
       read_at::text AS read_at, emailed_at::text AS emailed_at,
       created_at::text AS created_at`;

/** Insert one notification row. */
export async function insertNotification(input: {
  userId: number;
  workItemId?: number | null;
  kind: string;
  title: string;
  body?: string | null;
}): Promise<NotificationRow> {
  const result = await pool.query<NotificationRow>(
    `INSERT INTO notifications (user_id, work_item_id, kind, title, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [input.userId, input.workItemId ?? null, input.kind, input.title, input.body ?? null]
  );
  return result.rows[0];
}

/** A user's notifications, newest first. */
export async function listNotifications(
  userId: number,
  options: { unreadOnly?: boolean; limit?: number } = {}
): Promise<NotificationRow[]> {
  const result = await pool.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE user_id = $1${options.unreadOnly ? ' AND read_at IS NULL' : ''}
     ORDER BY created_at DESC, notification_id DESC
     LIMIT $2`,
    [userId, options.limit ?? 50]
  );
  return result.rows;
}

/** Unread count for the bell badge. */
export async function countUnreadNotifications(userId: number): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return parseInt(result.rows[0]?.total ?? '0', 10);
}

/** Mark one of the user's notifications read. Returns true when a row matched. */
export async function markNotificationRead(
  notificationId: number,
  userId: number
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE notification_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [notificationId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Mark all the user's notifications read. Returns the number updated. */
export async function markAllNotificationsRead(userId: number): Promise<number> {
  const result = await pool.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return result.rowCount ?? 0;
}

/** Stamp emailed_at on delivered notifications (emailer bookkeeping). */
export async function markNotificationsEmailed(notificationIds: number[]): Promise<void> {
  if (notificationIds.length === 0) return;
  await pool.query(
    `UPDATE notifications SET emailed_at = now() WHERE notification_id = ANY($1)`,
    [notificationIds]
  );
}

/** A user's not-yet-emailed notifications, oldest first (digest assembly). */
export async function listUnemailedNotifications(userId: number): Promise<NotificationRow[]> {
  const result = await pool.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE user_id = $1 AND emailed_at IS NULL
     ORDER BY created_at ASC, notification_id ASC`,
    [userId]
  );
  return result.rows;
}

/** Distinct user ids with pending (unemailed) notifications (digest sweep). */
export async function listUserIdsWithUnemailedNotifications(): Promise<number[]> {
  const result = await pool.query<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM notifications WHERE emailed_at IS NULL`
  );
  return result.rows.map((row) => row.user_id);
}

export interface NotificationPreferencesRow {
  user_id: number;
  email_mode: 'immediate' | 'digest' | 'off';
  urgent_email_immediate: boolean;
  digest_hour_local: number;
  in_app_enabled: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Omit<NotificationPreferencesRow, 'user_id'> = {
  email_mode: 'digest',
  urgent_email_immediate: true,
  digest_hour_local: 8,
  in_app_enabled: true,
};

/** The user's preferences, falling back to the schema defaults when unset. */
export async function getNotificationPreferences(
  userId: number
): Promise<NotificationPreferencesRow> {
  const result = await pool.query<NotificationPreferencesRow>(
    `SELECT user_id, email_mode, urgent_email_immediate, digest_hour_local, in_app_enabled
     FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] ?? { user_id: userId, ...DEFAULT_NOTIFICATION_PREFERENCES };
}

/** Upsert the user's preferences; unspecified fields keep current values. */
export async function upsertNotificationPreferences(
  userId: number,
  prefs: Partial<Omit<NotificationPreferencesRow, 'user_id'>>
): Promise<NotificationPreferencesRow> {
  const current = await getNotificationPreferences(userId);
  const next = { ...current, ...prefs };
  const result = await pool.query<NotificationPreferencesRow>(
    `INSERT INTO notification_preferences
       (user_id, email_mode, urgent_email_immediate, digest_hour_local, in_app_enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       email_mode = EXCLUDED.email_mode,
       urgent_email_immediate = EXCLUDED.urgent_email_immediate,
       digest_hour_local = EXCLUDED.digest_hour_local,
       in_app_enabled = EXCLUDED.in_app_enabled
     RETURNING user_id, email_mode, urgent_email_immediate, digest_hour_local, in_app_enabled`,
    [userId, next.email_mode, next.urgent_email_immediate, next.digest_hour_local, next.in_app_enabled]
  );
  return result.rows[0];
}
