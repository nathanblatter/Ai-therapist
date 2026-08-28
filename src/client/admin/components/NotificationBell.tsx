import { useEffect, useRef, useState } from 'react';
import { Bell, Check } from 'react-feather';
import useNotifications from '../hooks/useNotifications';
import { timeAgo } from '../hooks/useWorkQueue';

// Header bell: unread badge + dropdown of recent in-app notifications.
// Designed to sit in AdminHeader's dark toolbar (integration slice mounts it).

interface NotificationBellProps {
  /** Navigate when a notification is clicked (e.g. open the work queue). */
  onNavigate?: (notification: { kind: string; work_item_id: number | null }) => void;
}

export default function NotificationBell({ onNavigate }: NotificationBellProps) {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 text-white hover:bg-white/10 rounded-full"
        title="Notifications"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white text-ink rounded-lg shadow-lg border border-gray-200 z-50">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
            <span className="font-semibold text-sm">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={() => void markAllRead()}
                className="text-xs text-royal hover:underline flex items-center gap-1"
              >
                <Check size={12} />
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">No notifications yet.</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.notification_id}
                  onClick={() => {
                    if (!n.read_at) void markRead(n.notification_id);
                    if (onNavigate) {
                      setOpen(false);
                      onNavigate({ kind: n.kind, work_item_id: n.work_item_id });
                    }
                  }}
                  className={`w-full text-left px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 ${
                    n.read_at ? 'opacity-70' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read_at && (
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-royal shrink-0" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{n.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {n.kind.replace(/_/g, ' ')} &bull; {timeAgo(n.created_at)}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
