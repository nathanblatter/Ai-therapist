import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './useSocket';

// In-app notification hook (caseworker portal): bell list + unread badge with
// live refresh on notification:new, plus read/mark-all actions and the
// notification-preferences load/save pair used by NotificationPreferences.

export interface AppNotification {
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

export interface NotificationPreferences {
  email_mode: 'immediate' | 'digest' | 'off';
  urgent_email_immediate: boolean;
  digest_hour_local: number;
  in_app_enabled: boolean;
}

export default function useNotifications(limit = 30) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { socket } = useSocket();

  const refetch = useCallback(() => {
    setError(null);
    fetch(`/admin/api/notifications?limit=${limit}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<{ notifications: AppNotification[]; unread_count: number }>;
      })
      .then((data) => {
        setNotifications(data.notifications);
        setUnreadCount(data.unread_count);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [limit]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!socket) return;
    const onNew = () => refetch();
    socket.on('notification:new', onNew);
    return () => {
      socket.off('notification:new', onNew);
    };
  }, [socket, refetch]);

  const markRead = useCallback(
    async (notificationId: number) => {
      try {
        await fetch(`/admin/api/notifications/${notificationId}/read`, {
          method: 'POST',
          credentials: 'include',
        });
        setNotifications((prev) =>
          prev.map((n) =>
            n.notification_id === notificationId && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n
          )
        );
        setUnreadCount((count) => Math.max(0, count - 1));
      } catch {
        // Best-effort: the next refetch reconciles.
      }
    },
    []
  );

  const markAllRead = useCallback(async () => {
    try {
      await fetch('/admin/api/notifications/read-all', { method: 'POST', credentials: 'include' });
      setNotifications((prev) =>
        prev.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() }))
      );
      setUnreadCount(0);
    } catch {
      // Best-effort: the next refetch reconciles.
    }
  }, []);

  return { notifications, unreadCount, loading, error, refetch, markRead, markAllRead };
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const res = await fetch('/admin/api/notifications/preferences', { credentials: 'include' });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = (await res.json()) as { preferences: NotificationPreferences };
  return data.preferences;
}

export async function saveNotificationPreferences(
  prefs: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const res = await fetch('/admin/api/notifications/preferences', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  const data = (await res.json()) as { preferences: NotificationPreferences };
  return data.preferences;
}
