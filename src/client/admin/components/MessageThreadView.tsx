// Clinician-side conversation view (caseworker portal, docs/caseworker-portal.md
// section 4). Two entry modes:
//   - threadId: open a known thread (MessagingInbox)
//   - clientId: resolve the CALLER's own thread with that client
//     (ParticipantProfile Messages tab), offering get-or-create when none
//     exists yet. Only ever the caller's own correspondence — the server
//     404s anyone else's threads.
// Clinicians see scan verdicts (flagged chip with severity) on participant
// messages; sends are disabled with an explanation on frozen threads.
// Messaging state (60s poll + focus refresh + hidden-tab pause, 409/429 send
// handling, socket nudges) lives in the shared useThreadMessaging hook.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Lock, MessageSquare, Send } from 'react-feather';
import { useSocket } from '../hooks/useSocket';
import { useThreadMessaging, type ThreadBase, type ThreadMessageBase } from '../../shared/messaging/useThreadMessaging';
import { timeLabel } from '../../shared/format';
import { severityBadgeClass } from '../../shared/severity';
import Badge from '../../shared/components/Badge';

export interface AdminThread extends ThreadBase {
  client_id: number;
}

export interface AdminThreadMessage extends ThreadMessageBase {
  risk_score: number | null;
  risk_severity: 'low' | 'medium' | 'high' | null;
  scan_status: 'not_applicable' | 'pending' | 'clear' | 'flagged' | 'scan_failed';
  crisis_event_id: number | null;
}

function FlaggedChip({ severity }: { severity: 'low' | 'medium' | 'high' | null }) {
  return (
    <Badge toneClass={severityBadgeClass(severity ?? 'medium')} weight="normal">
      <AlertTriangle size={12} aria-hidden="true" />
      Flagged{severity ? ` (${severity} risk)` : ''}
    </Badge>
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
  const [resolved, setResolved] = useState(threadId !== undefined); // profile mode resolves first
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const { socket } = useSocket();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const {
    selectedThread: thread,
    selectThread,
    upsertThread,
    messages,
    loadingMessages,
    sendMessage,
    sending,
    error: messagingError,
  } = useThreadMessaging<AdminThread, AdminThreadMessage>({
    basePath: '/api/admin/messaging',
    threadsUrl: null, // single-thread view: no inbox list to poll
    socket,
    reloadOnAnyScanVerdict: true,
  });

  // Inbox mode opens the known thread; profile mode resolves the caller's own
  // thread with the client first.
  useEffect(() => {
    if (threadId !== undefined) {
      setResolved(true);
      selectThread(threadId);
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
          upsertThread(own);
          selectThread(own.thread_id);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(true);
          setResolveError('Could not load messaging for this client.');
        }
      });
    return () => { cancelled = true; };
  }, [threadId, clientId, selectThread, upsertThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const startConversation = async () => {
    if (clientId === undefined || creating) return;
    setCreating(true);
    setResolveError(null);
    try {
      const res = await fetch('/api/admin/messaging/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ client_id: clientId }),
      });
      if (!res.ok) {
        setResolveError('Could not start a conversation with this client.');
        return;
      }
      const data = await res.json() as { thread: AdminThread };
      upsertThread(data.thread);
      // A brand-new thread has no messages yet; skip the initial load.
      selectThread(data.thread.thread_id, { skipLoad: true });
    } catch {
      setResolveError('Could not start a conversation with this client.');
    } finally {
      setCreating(false);
    }
  };

  const send = async () => {
    if (!draft.trim() || sending) return;
    const ok = await sendMessage(draft);
    if (ok) setDraft('');
  };

  const error = messagingError ?? resolveError;
  // Inbox mode counts as loading until the known thread's first load lands.
  const awaitingThread = threadId !== undefined && thread === null && error === null;
  const loading = !resolved || loadingMessages || awaitingThread;

  // Profile mode, no thread yet: offer to start one.
  if (threadId === undefined && resolved && thread === null && !loadingMessages) {
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
          <Badge tone="gray" weight="normal">
            <Lock size={12} aria-hidden="true" /> Frozen
          </Badge>
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
