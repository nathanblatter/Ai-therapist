import { useCallback, useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import useAdminFetch from './useAdminFetch';
import { postJson } from '../../shared/http';

// Work-queue data hook (caseworker portal): list + ack/resolve actions with
// live refresh on work_item socket events. The server enforces visibility
// (assignee or caseload pool); this hook is presentation plumbing only.
// GET plumbing is composed from useAdminFetch; actions go through postJson.

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

export default function useWorkQueue(statuses: string[] = ['open', 'acked']) {
  const [actionError, setActionError] = useState<string | null>(null);
  const { socket } = useSocket();

  const statusKey = statuses.join(',');
  const { data, loading, error, refetch } = useAdminFetch<{ items: AttentionWorkItem[] }>(
    `/admin/api/work-items?status=${encodeURIComponent(statusKey)}`
  );
  const items = data?.items ?? [];

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
        await postJson(`/admin/api/work-items/${itemId}/${action}`, body);
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

  // Only surface loading before the first payload lands: socket-triggered
  // refetches must not flash the queue back to a spinner.
  return { items, loading: loading && data === null, error, actionError, refetch, ack, resolve };
}
