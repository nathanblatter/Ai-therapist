// Participant messaging state (caseworker portal, docs/caseworker-portal.md
// section 4): a thin wrapper around the shared useThreadMessaging hook
// (src/client/shared/messaging) bound to the participant API. Polling, focus
// refresh, hidden-tab pause, 409/429 send handling and the messaging:* socket
// nudges all live in the shared hook.
import { useEffect, useState } from 'react';
import { useThreadMessaging, type ThreadBase, type ThreadMessageBase } from '../../shared/messaging/useThreadMessaging';
import { getUserSocket } from '../lib/userSocket';

export interface ParticipantThread extends ThreadBase {
  created_at: string;
  unread_count?: number;
  last_message_preview?: string | null;
}

export interface ParticipantMessage extends ThreadMessageBase {
  flagged: boolean;
}

const POLL_INTERVAL_MS = 60_000;

export function useMessaging(options: { active: boolean }) {
  const {
    threads,
    unreadTotal,
    loadingThreads,
    selectedThread,
    selectedThreadId,
    selectThread,
    messages,
    loadingMessages,
    sendMessage,
    sending,
    error,
    refreshThreads,
  } = useThreadMessaging<ParticipantThread, ParticipantMessage>({
    basePath: '/api/messaging',
    active: options.active,
    getSocket: getUserSocket,
  });

  return {
    threads,
    unreadTotal,
    loadingThreads,
    selectedThread,
    selectedThreadId,
    selectThread,
    messages,
    loadingMessages,
    sendMessage,
    sending,
    error,
    refreshThreads,
  };
}

/**
 * Lightweight unread badge for the header (integration wires it into
 * App/Header): total unread across threads, socket-nudged, 60s poll.
 * Returns 0 for anonymous users (401s are swallowed).
 */
export function useMessagingUnread(enabled: boolean): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch('/api/messaging/threads', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json() as { unread_total: number };
        if (!cancelled) setUnread(data.unread_total);
      } catch { /* keep last value */ }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const socket = getUserSocket();
    const nudge = () => void refresh();
    socket.on('messaging:new-message', nudge);
    socket.on('messaging:read', nudge);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      socket.off('messaging:new-message', nudge);
      socket.off('messaging:read', nudge);
    };
  }, [enabled]);

  return enabled ? unread : 0;
}
