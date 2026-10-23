// Session Detail risk panel for crisis events (eval program WP2): lists the
// session's crisis_events rows with the adjudication widget on each so a
// reviewer can confirm / dismiss a flag where the transcript is. Backed by
// GET /admin/api/crisis/events?sessionId=... (summary-tier scrubbed server-side).
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'react-feather';
import { getJson } from '../../shared/http';
import { severityBadgeClass } from '../../shared/severity';
import CrisisAdjudication, { type AdjudicationSummary } from './CrisisAdjudication';

interface CrisisEventRow {
  event_id: number | string;
  event_type: string;
  severity?: string | null;
  risk_score?: number | null;
  triggered_by: string;
  trigger_method: string;
  created_at: string;
  adjudications?: AdjudicationSummary[] | null;
}

export default function SessionCrisisEvents({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<CrisisEventRow[] | null>(null);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getJson<{ events: CrisisEventRow[] }>(
        `/admin/api/crisis/events?sessionId=${encodeURIComponent(sessionId)}`,
      );
      setEvents(data.events ?? []);
    } catch (err) {
      console.error('Failed to fetch session crisis events:', err);
      setEvents([]);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!events || events.length === 0) return null;
  const unadjudicated = events.filter((e) => !e.adjudications?.length).length;

  return (
    <div className="mb-4 bg-white border border-gray-200 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 transition"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <AlertTriangle size={16} className="text-red-500" />
          <span className="font-semibold text-navy">Crisis events</span>
          <span className="text-xs text-gray-500">
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
          {unadjudicated > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
              {unadjudicated} unadjudicated
            </span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          {events.map((event) => (
            <div key={event.event_id} className="p-3 bg-gray-50 rounded border border-gray-100">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${severityBadgeClass(event.severity ?? undefined)}`}
                >
                  {event.severity || 'n/a'}
                </span>
                <span className="font-semibold">{event.event_type.replace(/_/g, ' ')}</span>
                {typeof event.risk_score === 'number' && <span className="text-gray-600">risk {event.risk_score}</span>}
                <span className="text-xs text-gray-500">
                  {event.triggered_by} via {event.trigger_method} · {new Date(event.created_at).toLocaleString()}
                </span>
              </div>
              <CrisisAdjudication
                eventId={event.event_id}
                adjudications={event.adjudications}
                compact
                onSaved={(next) =>
                  setEvents((prev) =>
                    (prev ?? []).map((e) => (e.event_id === event.event_id ? { ...e, adjudications: next } : e)),
                  )
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
