// Participant messaging state (caseworker portal, docs/caseworker-portal.md
// section 4). Sockets are latency sugar only: the hook HTTP-polls the thread
// list every 60s while active and re-fetches on window focus, so messaging
// works even when the tunnel never delivers a websocket. Socket events
// (messaging:*) just trigger the same refresh paths sooner.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getUserSocket } from '../lib/userSocket';

export interface ParticipantThread {
  thread_id: number;
  clinician_id: number;
  clinician_role: 'therapist' | 'caseworker';
  status: 'active' | 'frozen';
  frozen_reason: string | null;
  created_at: string;
  last_message_at: string | null;
  counterpart_username?: string | null;
  unread_count?: number;
  last_message_preview?: string | null;
}

export interface ParticipantMessage {
  message_id: number;
  thread_id: number;
  sender_id: number;
  sender_role: 'participant' | 'therapist' | 'caseworker';
  body: string;
  created_at: string;
  flagged: boolean;
}

const POLL_INTERVAL_MS = 60_000;

export function useMessaging(options: { active: boolean }) {
  const { active } = options;
  const [threads, setThreads] = useState<ParticipantThread[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ParticipantMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so socket/interval callbacks see current values without re-binding.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedThreadId;
  const activeRef = useRef(active);
  activeRef.current = active;

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch('/api/messaging/threads', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json() as { threads: ParticipantThread[]; unread_total: number };
      setThreads(data.threads);
      setUnreadTotal(data.unread_total);
    } catch {
      /* poll again later; stale list is fine */
    }
  }, []);

  const loadMessages = useCallback(async (threadId: number) => {
    setLoadingMessages(true);
    setError(null);
    try {
      const res = await fetch(`/api/messaging/threads/${threadId}/messages`, { credentials: 'include' });
      if (!res.ok) {
        setError('Could not load this conversation.');
        return;
      }
      const data = await res.json() as { thread: ParticipantThread; messages: ParticipantMessage[] };
      setMessages(data.messages);
      // Keep the thread row (status/frozen) fresh alongside its messages.
      setThreads(prev => prev.map(t => (t.thread_id === threadId ? { ...t, ...data.thread } : t)));
      // Mark read up to the newest visible message (fire-and-forget).
      const newest = data.messages[data.messages.length - 1];
      if (newest) {
        void fetch(`/api/messaging/threads/${threadId}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ last_read_message_id: newest.message_id }),
        }).then(() => refreshThreads()).catch(() => { /* retried on next open */ });
      }
    } catch {
      setError('Could not load this conversation.');
    } finally {
      setLoadingMessages(false);
    }
  }, [refreshThreads]);

  const selectThread = useCallback((threadId: number | null) => {
    setSelectedThreadId(threadId);
    setMessages([]);
    setError(null);
    if (threadId !== null) void loadMessages(threadId);
  }, [loadMessages]);

  const sendMessage = useCallback(async (body: string): Promise<boolean> => {
    const threadId = selectedRef.current;
    if (threadId === null || !body.trim()) return false;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/messaging/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: body.trim() }),
      });
      if (res.status === 409) {
        setError('This conversation is closed and no longer accepts new messages.');
        void refreshThreads();
        return false;
      }
      if (res.status === 429) {
        setError('You have sent a lot of messages recently. Please wait a bit and try again.');
        return false;
      }
      if (!res.ok) {
        setError('Your message could not be sent. Please try again.');
        return false;
      }
      const data = await res.json() as { message: ParticipantMessage };
      setMessages(prev => [...prev, data.message]);
      void refreshThreads();
      return true;
    } catch {
      setError('Your message could not be sent. Please try again.');
      return false;
    } finally {
      setSending(false);
    }
  }, [refreshThreads]);

  // Initial load + polling while the view is active + focus refresh.
  useEffect(() => {
    if (!active) return;
    setLoadingThreads(true);
    void refreshThreads().finally(() => setLoadingThreads(false));

    const interval = window.setInterval(() => {
      void refreshThreads();
      const threadId = selectedRef.current;
      if (threadId !== null) void loadMessages(threadId);
    }, POLL_INTERVAL_MS);

    const onFocus = () => {
      void refreshThreads();
      const threadId = selectedRef.current;
      if (threadId !== null) void loadMessages(threadId);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, refreshThreads, loadMessages]);

  // Socket refreshes (faster than the poll; correctness never depends on it).
  useEffect(() => {
    const socket = getUserSocket();
    const onNewMessage = (payload: { threadId: number }) => {
      void refreshThreads();
      if (activeRef.current && selectedRef.current === payload.threadId) {
        void loadMessages(payload.threadId);
      }
    };
    const onFrozen = () => { void refreshThreads(); };
    const onScanned = (payload: { threadId: number; flagged: boolean }) => {
      // A flag flips the supportive-resources banner under the message.
      if (payload.flagged && activeRef.current && selectedRef.current === payload.threadId) {
        void loadMessages(payload.threadId);
      }
    };
    socket.on('messaging:new-message', onNewMessage);
    socket.on('messaging:thread-frozen', onFrozen);
    socket.on('messaging:message-scanned', onScanned);
    return () => {
      socket.off('messaging:new-message', onNewMessage);
      socket.off('messaging:thread-frozen', onFrozen);
      socket.off('messaging:message-scanned', onScanned);
    };
  }, [refreshThreads, loadMessages]);

  const selectedThread = threads.find(t => t.thread_id === selectedThreadId) ?? null;

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
