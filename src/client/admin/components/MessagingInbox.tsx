// Clinician messaging inbox (caseworker portal, docs/caseworker-portal.md
// section 4): the caller's own threads (therapist or caseworker tier alike —
// each clinician only ever sees their own correspondence), newest activity
// first, with unread badges and flagged-thread markers. Selecting a thread
// opens MessageThreadView. Polling + focus refresh keep it correct without a
// socket; the shared admin socket nudges it sooner.
import { useEffect, useState } from 'react';
import { AlertTriangle, MessageSquare } from 'react-feather';
import Panel from './ui/Panel';
import MessageThreadView, { type AdminThread } from './MessageThreadView';
import { useSocket } from '../hooks/useSocket';

interface InboxThread extends AdminThread {
  unread_count: number;
  last_message_preview: string | null;
  is_sandbox?: boolean;
}

interface InboxPayload {
  threads: InboxThread[];
  unread_total: number;
}

const POLL_INTERVAL_MS = 60_000;

function timeLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function MessagingInbox() {
  const [data, setData] = useState<InboxPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const { socket } = useSocket();

  const refresh = async () => {
    try {
      const res = await fetch('/api/admin/messaging/inbox', { credentials: 'include' });
      if (!res.ok) {
        setError(`Failed to load inbox (${res.status})`);
        return;
      }
      setData(await res.json() as InboxPayload);
      setError(null);
    } catch {
      setError('Failed to load inbox');
    }
  };

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!socket) return;
    const nudge = () => void refresh();
    socket.on('messaging:new-message', nudge);
    socket.on('messaging:read', nudge);
    socket.on('messaging:thread-frozen', nudge);
    return () => {
      socket.off('messaging:new-message', nudge);
      socket.off('messaging:read', nudge);
      socket.off('messaging:thread-frozen', nudge);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  if (selectedThreadId !== null) {
    const thread = data?.threads.find(t => t.thread_id === selectedThreadId);
    return (
      <Panel className="h-[70vh] flex flex-col">
        <MessageThreadView
          threadId={selectedThreadId}
          clientName={thread?.counterpart_username ?? undefined}
          onBack={() => {
            setSelectedThreadId(null);
            void refresh();
          }}
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <Panel title="Messages" icon={MessageSquare}>
        <p className="text-sm text-gray-500 -mt-2 mb-4">
          Secure asynchronous messages with clients on your caseload. Participants are told
          replies take 1&ndash;2 business days; every participant message is safety-scanned.
        </p>
        {error && <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>}
        {data === null && !error ? (
          <p className="text-sm text-gray-400 py-4 text-center">Loading&hellip;</p>
        ) : data !== null && data.threads.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            No conversations yet. Start one from a client&apos;s profile (Messages tab).
          </p>
        ) : data !== null ? (
          <ul className="divide-y divide-gray-100">
            {data.threads.map(t => (
              <li key={t.thread_id}>
                <button
                  onClick={() => setSelectedThreadId(t.thread_id)}
                  className="w-full flex items-center gap-3 py-3 text-left hover:bg-gray-50 rounded-lg px-2 -mx-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {t.counterpart_username || `Client ${t.client_id}`}
                      {t.status === 'frozen' && (
                        <span className="ml-2 text-xs text-gray-400 font-normal">(frozen)</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {t.last_message_preview || 'No messages yet'}
                    </p>
                  </div>
                  {t.unread_count > 0 && (
                    <span className="flex-shrink-0 text-xs font-semibold text-white bg-blue-600 rounded-full px-2 py-0.5">
                      {t.unread_count}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 flex-shrink-0">{timeLabel(t.last_message_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <p className="text-xs text-gray-400 flex items-center gap-1.5 px-1">
        <AlertTriangle size={12} aria-hidden="true" />
        Flagged participant messages also appear in Crisis Management and your work queue.
      </p>
    </div>
  );
}
