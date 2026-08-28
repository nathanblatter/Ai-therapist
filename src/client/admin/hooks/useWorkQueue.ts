import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './useSocket';

// Work-queue data hook (caseworker portal): list + ack/resolve actions with
// live refresh on work_item socket events. The server enforces visibility
// (assignee or caseload pool); this hook is presentation plumbing only.

export interface AttentionWorkItem {
  item_id: number;
  org_id: number;
  client_id: number | null;
  assignee_id: number | null;
  assignee_role: string | null;
  item_type: string;
  severity: 'info' | 'warning' | 'urgent';
  title: string;
  detail: Record<string, unknown> | null;
  status: 'open' | 'acked' | 'resolved' | 'expired';
  acked_by: number | null;
  acked_at: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  resolution_note: string | null;
  is_sandbox: boolean;
  created_at: string;
}

/** Compact relative timestamp for queue/notification rows. */
export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function useWorkQueue(statuses: string[] = ['open', 'acked']) {
  const [items, setItems] = useState<AttentionWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { socket } = useSocket();

  const statusKey = statuses.join(',');

  const refetch = useCallback(() => {
    setError(null);
    fetch(`/admin/api/work-items?status=${encodeURIComponent(statusKey)}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<{ items: AttentionWorkItem[] }>;
      })
      .then((data) => setItems(data.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [statusKey]);

  useEffect(() => {
    setLoading(true);
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!socket) return;
    const onChange = () => refetch();
    socket.on('work_item:new', onChange);
    socket.on('work_item:updated', onChange);
    return () => {
      socket.off('work_item:new', onChange);
      socket.off('work_item:updated', onChange);
    };
  }, [socket, refetch]);

  const post = useCallback(
    async (itemId: number, action: 'ack' | 'resolve', body?: Record<string, unknown>) => {
      setActionError(null);
      try {
        const res = await fetch(`/admin/api/work-items/${itemId}/${action}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `Request failed (${res.status})`);
        }
        refetch();
        return true;
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : 'Action failed');
        return false;
      }
    },
    [refetch]
  );

  const ack = useCallback((itemId: number) => post(itemId, 'ack'), [post]);
  const resolve = useCallback(
    (itemId: number, resolutionNote?: string) =>
      post(itemId, 'resolve', resolutionNote ? { resolution_note: resolutionNote } : {}),
    [post]
  );

  return { items, loading, error, actionError, refetch, ack, resolve };
}
