// Flagged-message crisis rows for the CrisisManagement embed (caseworker
// portal, docs/caseworker-portal.md section 4): crisis_events rows with
// origin='thread_message' (migration 076). These events have NO session —
// the row links to the message thread instead of a session detail view.
// Payloads are summary-tier by construction: severity, score, factor labels —
// never the message body.
//
// Exports:
//   - useFlaggedMessageEvents(): fetch hook for /api/admin/messaging/flagged
//     (care-team callers are caseload-scoped server-side)
//   - FlaggedMessageRow: one row (icon, client, severity, factors, time,
//     "View thread" action via onOpenThread)
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, MessageSquare } from 'react-feather';
import { severityBadgeClass } from '../../shared/severity';
import Badge from '../../shared/components/Badge';

export interface FlaggedMessageEvent {
  event_id: number;
  origin: 'thread_message';
  thread_message_id: number | null;
  client_user_id: number | null;
  username: string | null;
  thread_id: number | null;
  severity: 'low' | 'medium' | 'high' | null;
  risk_score: number | null;
  risk_factors: string[] | string | null;
  notes: string | null;
  created_at: string;
}

export function useFlaggedMessageEvents(): {
  events: FlaggedMessageEvent[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [events, setEvents] = useState<FlaggedMessageEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/messaging/flagged', { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json() as Promise<{ events: FlaggedMessageEvent[] }>;
      })
      .then(data => {
        setEvents(data.events);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { events, loading, error, refetch };
}

function factorLabels(raw: FlaggedMessageEvent['risk_factors']): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface FlaggedMessageRowProps {
  event: FlaggedMessageEvent;
  /** Open the message thread (integration points this at the messaging view). */
  onOpenThread?: (threadId: number) => void;
}

export default function FlaggedMessageRow({ event, onOpenThread }: FlaggedMessageRowProps) {
  const factors = factorLabels(event.risk_factors);

  return (
    <div className="flex items-center gap-3 py-3">
      <AlertTriangle
        size={18}
        className={event.severity === 'high' ? 'text-red-500 flex-shrink-0' : 'text-amber-500 flex-shrink-0'}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-800 truncate">
            {event.username || (event.client_user_id !== null ? `Client ${event.client_user_id}` : 'Unknown client')}
          </p>
          <Badge toneClass={severityBadgeClass(event.severity)} weight="normal">
            {event.severity ? `${event.severity} risk` : 'flagged'}
            {event.risk_score !== null ? ` (${event.risk_score})` : ''}
          </Badge>
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <MessageSquare size={12} aria-hidden="true" /> Flagged message
          </span>
        </div>
        {factors.length > 0 && (
          <p className="text-xs text-gray-500 truncate mt-0.5">{factors.join(', ')}</p>
        )}
      </div>
      <span className="text-xs text-gray-400 flex-shrink-0">
        {new Date(event.created_at).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })}
      </span>
      {event.thread_id !== null && onOpenThread && (
        <button
          onClick={() => onOpenThread(event.thread_id!)}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
        >
          View thread
        </button>
      )}
    </div>
  );
}
