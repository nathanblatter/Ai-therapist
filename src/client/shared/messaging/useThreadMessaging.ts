// Transport-agnostic secure-messaging state hook (caseworker portal,
// docs/caseworker-portal.md section 4), shared by the participant Messages
// view ('/api/messaging') and the clinician inbox/thread views
// ('/api/admin/messaging'). The admin components were originally hand-copied
// from the participant hook and drifted: the copy lost 429 rate-limit
// handling and never paused polling in hidden tabs — both are fixed here for
// every consumer.
//
// Sockets are latency sugar only: the hook HTTP-polls every 60s while active
// and visible, and re-fetches on window focus / tab re-show, so messaging
// works even when the tunnel never delivers a websocket. Socket events
// (messaging:*) just trigger the same refresh paths sooner.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ThreadBase {
  thread_id: number;
  clinician_id: number;
  clinician_role: 'therapist' | 'caseworker';
  status: 'active' | 'frozen';
  frozen_reason: string | null;
  last_message_at: string | null;
  counterpart_username?: string | null;
}

export interface ThreadMessageBase {
  message_id: number;
  thread_id: number;
  sender_id: number;
  sender_role: 'participant' | 'therapist' | 'caseworker';
  body: string;
  created_at: string;
}

type MessagingEventPayload = { threadId?: number; flagged?: boolean };

/** Anything with socket.io-style on/off (participant user socket, admin socket). */
export interface MessagingSocket {
  on(event: string, handler: (payload: MessagingEventPayload) => void): unknown;
  off(event: string, handler: (payload: MessagingEventPayload) => void): unknown;
}

export interface UseThreadMessagingOptions {
  /** API prefix: '/api/messaging' or '/api/admin/messaging'. */
  basePath: string;
  /**
   * Thread-list endpoint (expects { threads, unread_total }). Defaults to
   * `${basePath}/threads`; pass null for single-thread views (no list).
   */
  threadsUrl?: string | null;
  /** Poll/refresh only while true (e.g. the participant Messages view is open). */
  active?: boolean;
  /** Socket instance (admin useSocket) — may be null until connected. */
  socket?: MessagingSocket | null;
  /** Lazily resolved socket (participant getUserSocket; avoids SSR/render-time connects). */
  getSocket?: () => MessagingSocket | null;
  /**
   * Reload the open thread on every messaging:message-scanned verdict.
   * Clinician views show clear/failed verdicts too; the participant view only
   * re-renders when a message is flagged (supportive-resources banner).
   */
  reloadOnAnyScanVerdict?: boolean;
}

const POLL_INTERVAL_MS = 60_000;

export function useThreadMessaging<
  TThread extends ThreadBase = ThreadBase,
  TMessage extends ThreadMessageBase = ThreadMessageBase,
>(options: UseThreadMessagingOptions) {
  const {
    basePath,
    threadsUrl = `${options.basePath}/threads`,
    active = true,
    socket = null,
    getSocket,
    reloadOnAnyScanVerdict = false,
  } = options;

  const [threads, setThreads] = useState<TThread[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [threadsError, setThreadsError] = useState<{ status: number | null } | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<TMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so socket/interval callbacks see current values without re-binding.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedThreadId;
  const activeRef = useRef(active);
  activeRef.current = active;

  /** Merge a thread row into the list (upsert: single-thread views start empty). */
  const upsertThread = useCallback((thread: TThread) => {
    setThreads(prev =>
      prev.some(t => t.thread_id === thread.thread_id)
        ? prev.map(t => (t.thread_id === thread.thread_id ? { ...t, ...thread } : t))
        : [...prev, thread]
    );
  }, []);

  const refreshThreads = useCallback(async () => {
    if (!threadsUrl) return;
    try {
      const res = await fetch(threadsUrl, { credentials: 'include' });
      if (!res.ok) {
        setThreadsError({ status: res.status });
        return;
      }
      const data = await res.json() as { threads: TThread[]; unread_total?: number };
      setThreads(data.threads);
      if (typeof data.unread_total === 'number') setUnreadTotal(data.unread_total);
      setThreadsError(null);
      setThreadsLoaded(true);
    } catch {
      // Poll again later; a stale list is fine.
      setThreadsError({ status: null });
    }
  }, [threadsUrl]);

  const loadMessages = useCallback(async (threadId: number) => {
    setLoadingMessages(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/threads/${threadId}/messages`, { credentials: 'include' });
      if (!res.ok) {
        setError('Could not load this conversation.');
        return;
      }
      const data = await res.json() as { thread: TThread; messages: TMessage[] };
      setMessages(data.messages);
      // Keep the thread row (status/frozen) fresh alongside its messages.
      upsertThread(data.thread);
      // Mark read up to the newest visible message (fire-and-forget).
      const newest = data.messages[data.messages.length - 1];
      if (newest) {
        void fetch(`${basePath}/threads/${threadId}/read`, {
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
  }, [basePath, refreshThreads, upsertThread]);

  const selectThread = useCallback((threadId: number | null, opts?: { skipLoad?: boolean }) => {
    setSelectedThreadId(threadId);
    setMessages([]);
    setError(null);
    if (threadId !== null && !opts?.skipLoad) void loadMessages(threadId);
  }, [loadMessages]);

  const sendMessage = useCallback(async (body: string): Promise<boolean> => {
    const threadId = selectedRef.current;
    if (threadId === null || !body.trim()) return false;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: body.trim() }),
      });
      if (res.status === 409) {
        setError('This conversation is closed and no longer accepts new messages.');
        // Refresh so the frozen state renders (thread row + banner).
        void refreshThreads();
        void loadMessages(threadId);
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
      const data = await res.json() as { message: TMessage };
      setMessages(prev => [...prev, data.message]);
      void refreshThreads();
      return true;
    } catch {
      setError('Your message could not be sent. Please try again.');
      return false;
    } finally {
      setSending(false);
    }
  }, [basePath, refreshThreads, loadMessages]);

  // Initial load + polling while active + focus/visibility refresh. Hidden
  // tabs skip the poll tick and catch up when the tab is shown again.
  useEffect(() => {
    if (!active) return;
    if (threadsUrl) {
      setLoadingThreads(true);
      void refreshThreads().finally(() => setLoadingThreads(false));
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refreshThreads();
      const threadId = selectedRef.current;
      if (threadId !== null) void loadMessages(threadId);
    };
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (typeof document === 'undefined' || !document.hidden) tick();
    };
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, threadsUrl, refreshThreads, loadMessages]);

  // Socket refreshes (faster than the poll; correctness never depends on it).
  useEffect(() => {
    const sock = socket ?? getSocket?.() ?? null;
    if (!sock) return;
    const reloadIfSelected = (payload: MessagingEventPayload) => {
      const threadId = selectedRef.current;
      if (activeRef.current && threadId !== null && payload?.threadId === threadId) {
        void loadMessages(threadId);
      }
    };
    const onNewMessage = (payload: MessagingEventPayload) => {
      void refreshThreads();
      reloadIfSelected(payload);
    };
    const onRead = (payload: MessagingEventPayload) => {
      void refreshThreads();
      reloadIfSelected(payload);
    };
    const onFrozen = (payload: MessagingEventPayload) => {
      void refreshThreads();
      reloadIfSelected(payload);
    };
    const onScanned = (payload: MessagingEventPayload) => {
      // A flag flips the participant supportive-resources banner; clinician
      // views also re-render clear/failed verdict chips.
      if (reloadOnAnyScanVerdict || payload?.flagged) reloadIfSelected(payload);
    };
    sock.on('messaging:new-message', onNewMessage);
    sock.on('messaging:read', onRead);
    sock.on('messaging:thread-frozen', onFrozen);
    sock.on('messaging:message-scanned', onScanned);
    return () => {
      sock.off('messaging:new-message', onNewMessage);
      sock.off('messaging:read', onRead);
      sock.off('messaging:thread-frozen', onFrozen);
      sock.off('messaging:message-scanned', onScanned);
    };
  }, [socket, getSocket, refreshThreads, loadMessages, reloadOnAnyScanVerdict]);

  const selectedThread = threads.find(t => t.thread_id === selectedThreadId) ?? null;

  return {
    threads,
    setThreads,
    unreadTotal,
    loadingThreads,
    /** True once the thread list has loaded successfully at least once. */
    threadsLoaded,
    threadsError,
    selectedThread,
    selectedThreadId,
    selectThread,
    upsertThread,
    messages,
    setMessages,
    loadingMessages,
    sendMessage,
    sending,
    error,
    setError,
    refreshThreads,
    loadMessages,
  };
}
