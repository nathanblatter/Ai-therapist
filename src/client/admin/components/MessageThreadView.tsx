// Clinician-side conversation view (caseworker portal, docs/caseworker-portal.md
// section 4). Two entry modes:
//   - threadId: open a known thread (MessagingInbox)
//   - clientId: resolve the CALLER's own thread with that client
//     (ParticipantProfile Messages tab), offering get-or-create when none
//     exists yet. Only ever the caller's own correspondence — the server
//     404s anyone else's threads.
// Clinicians see scan verdicts (flagged chip with severity) on participant
// messages; sends are disabled with an explanation on frozen threads.
// Polling (60s + focus) keeps the view correct without a socket; the shared
// admin socket just refreshes sooner.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Lock, MessageSquare, Send } from 'react-feather';
import { useSocket } from '../hooks/useSocket';

export interface AdminThread {
  thread_id: number;
  client_id: number;
  clinician_id: number;
  clinician_role: 'therapist' | 'caseworker';
  status: 'active' | 'frozen';
  frozen_reason: string | null;
  last_message_at: string | null;
  counterpart_username?: string | null;
}

export interface AdminThreadMessage {
  message_id: number;
  thread_id: number;
  sender_id: number;
  sender_role: 'participant' | 'therapist' | 'caseworker';
  body: string;
  created_at: string;
  risk_score: number | null;
  risk_severity: 'low' | 'medium' | 'high' | null;
  scan_status: 'not_applicable' | 'pending' | 'clear' | 'flagged' | 'scan_failed';
  crisis_event_id: number | null;
}

const POLL_INTERVAL_MS = 60_000;

function timeLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function FlaggedChip({ severity }: { severity: 'low' | 'medium' | 'high' | null }) {
  const tone = severity === 'high' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800';
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${tone}`}>
      <AlertTriangle size={12} aria-hidden="true" />
      Flagged{severity ? ` (${severity} risk)` : ''}
    </span>
  );
}

interface MessageThreadViewProps {
  /** Open a known thread directly (inbox mode). */
  threadId?: number;
  /** Resolve the caller's own thread with this client (profile mode). */
  clientId?: number;
  /** Display name for the client in profile mode. */
  clientName?: string;
  /** Back handler; when present a back arrow is rendered. */
  onBack?: () => void;
}

export default function MessageThreadView({ threadId, clientId, clientName, onBack }: MessageThreadViewProps) {
  const [thread, setThread] = useState<AdminThread | null>(null);
  const [resolved, setResolved] = useState(threadId !== undefined); // profile mode resolves first
  const [messages, setMessages] = useState<AdminThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const { socket } = useSocket();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const threadIdRef = useRef<number | null>(threadId ?? null);

  const loadMessages = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/admin/messaging/threads/${id}/messages`, { credentials: 'include' });
      if (!res.ok) {
        setError('Could not load this conversation.');
        return;
      }
      const data = await res.json() as { thread: AdminThread; messages: AdminThreadMessage[] };
      setThread(data.thread);
      setMessages(data.messages);
      setError(null);
      const newest = data.messages[data.messages.length - 1];
      if (newest) {
        void fetch(`/api/admin/messaging/threads/${id}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ last_read_message_id: newest.message_id }),
        }).catch(() => { /* retried on next load */ });
      }
    } catch {
      setError('Could not load this conversation.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Profile mode: resolve the caller's own thread with the client.
  useEffect(() => {
    if (threadId !== undefined) {
      threadIdRef.current = threadId;
      setResolved(true);
      void loadMessages(threadId);
      return;
    }
    if (clientId === undefined) return;
    let cancelled = false;
    fetch(`/api/admin/messaging/clients/${clientId}/threads`, { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { threads: AdminThread[] } | null) => {
        if (cancelled) return;
        const own = data?.threads?.[0] ?? null;
        setResolved(true);
        if (own) {
          setThread(own);
          threadIdRef.current = own.thread_id;
          void loadMessages(own.thread_id);
        } else {
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(true);
          setLoading(false);
          setError('Could not load messaging for this client.');
        }
      });
    return () => { cancelled = true; };
  }, [threadId, clientId, loadMessages]);

  // Poll + focus refresh (sockets are latency sugar only).
  useEffect(() => {
    const tick = () => {
      const id = threadIdRef.current;
      if (id !== null) void loadMessages(id);
    };
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, [loadMessages]);

  // Socket nudges.
  useEffect(() => {
    if (!socket) return;
    const onEvent = (payload: { threadId?: number }) => {
      const id = threadIdRef.current;
      if (id !== null && payload?.threadId === id) void loadMessages(id);
    };
    socket.on('messaging:new-message', onEvent);
    socket.on('messaging:read', onEvent);
    socket.on('messaging:thread-frozen', onEvent);
    socket.on('messaging:message-scanned', onEvent);
    return () => {
      socket.off('messaging:new-message', onEvent);
      socket.off('messaging:read', onEvent);
      socket.off('messaging:thread-frozen', onEvent);
      socket.off('messaging:message-scanned', onEvent);
    };
  }, [socket, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const startConversation = async () => {
    if (clientId === undefined || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/messaging/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ client_id: clientId }),
      });
      if (!res.ok) {
        setError('Could not start a conversation with this client.');
        return;
      }
      const data = await res.json() as { thread: AdminThread };
      setThread(data.thread);
      threadIdRef.current = data.thread.thread_id;
      setMessages([]);
      setLoading(false);
    } catch {
      setError('Could not start a conversation with this client.');
    } finally {
      setCreating(false);
    }
  };

  const send = async () => {
    const id = threadIdRef.current;
    if (id === null || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/messaging/threads/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: draft.trim() }),
      });
      if (res.status === 409) {
        setError('This thread is frozen (the assignment ended); no new messages can be sent.');
        void loadMessages(id);
        return;
      }
      if (!res.ok) {
        setError('Message could not be sent.');
        return;
      }
      const data = await res.json() as { message: AdminThreadMessage };
      setMessages(prev => [...prev, data.message]);
      setDraft('');
    } catch {
      setError('Message could not be sent.');
    } finally {
      setSending(false);
    }
  };

  // Profile mode, no thread yet: offer to start one.
  if (resolved && thread === null && !loading) {
    return (
      <div className="text-center py-8">
        <MessageSquare size={24} className="mx-auto text-gray-300 mb-2" aria-hidden="true" />
        <p className="text-sm text-gray-500 mb-3">
          No message conversation with {clientName || 'this client'} yet.
        </p>
        {clientId !== undefined && (
          <button
            onClick={() => void startConversation()}
            disabled={creating}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
          >
            {creating ? 'Starting…' : 'Start conversation'}
          </button>
        )}
        {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
      </div>
    );
  }

  const frozen = thread?.status === 'frozen';
  const title = thread?.counterpart_username || clientName || 'Conversation';

  return (
    <div className="flex flex-col h-full min-h-[300px]">
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100 mb-3">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Back to inbox"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        )}
        <MessageSquare size={16} className="text-blue-600" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-gray-800 truncate">{title}</h3>
        {frozen && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
            <Lock size={12} aria-hidden="true" /> Frozen
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {loading && messages.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">Loading&hellip;</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No messages yet.</p>
        ) : (
          messages.map(m => {
            const mine = m.sender_role !== 'participant';
            return (
              <div key={m.message_id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                    mine ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'
                  }`}
                >
                  {m.body}
                </div>
                <div className="flex items-center gap-2 mt-0.5 px-1">
                  <p className="text-[11px] text-gray-400">{timeLabel(m.created_at)}</p>
                  {m.scan_status === 'flagged' && <FlaggedChip severity={m.risk_severity} />}
                  {m.scan_status === 'scan_failed' && (
                    <span className="text-[11px] text-gray-400">safety scan failed</span>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="text-sm text-red-600 mt-2" role="alert">{error}</p>}

      {frozen ? (
        <p className="text-xs text-gray-500 mt-3 flex items-center gap-1.5">
          <Lock size={12} aria-hidden="true" />
          This thread is read-only: the care-team assignment ended. Re-assignment reopens it.
        </p>
      ) : (
        <div className="flex items-end gap-2 mt-3">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            maxLength={4000}
            rows={2}
            placeholder="Write a message"
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700 resize-none"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            className="flex-shrink-0 p-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
            aria-label="Send message"
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
