// Therapist-only panel inside SessionDetail: the participant's pre-session
// check-in, the AI memory summary, and the draft SOAP note with a review
// workflow. Backed by routes/admin/insights.routes.ts (403 for researchers —
// both artifacts derive from unredacted content).
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, CheckCircle } from 'react-feather';

interface SessionSummary {
  headline?: string;
  topics?: string[];
  mood_trajectory?: string;
  techniques_discussed?: string[];
  techniques_helped?: string[];
  follow_up?: string;
}

interface SoapNote {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
}

interface Insights {
  summary: SessionSummary | null;
  soap_note: SoapNote | null;
  soap_status: 'draft' | 'reviewed';
  soap_reviewed_by: string | null;
  soap_reviewed_at: string | null;
  model: string | null;
}

interface Checkin {
  mood?: number;
  topic?: string;
  goal?: string;
}

interface SessionInsightsPanelProps {
  sessionId: string;
  userRole: string | null;
  sessionStatus?: string;
  checkin?: Checkin | null;
}

export default function SessionInsightsPanel({ sessionId, userRole, sessionStatus, checkin }: SessionInsightsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);

  const isTherapist = userRole === 'therapist';

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/insights`);
      if (res.ok) {
        setInsights(await res.json() as Insights);
      } else {
        setNotFound(true);
      }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (isTherapist && expanded && !insights) void fetchInsights();
  }, [isTherapist, expanded, insights, fetchInsights]);

  if (!isTherapist) return null;
  if (sessionStatus !== 'ended' && !checkin) return null;

  const handleReview = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/insights/review`, { method: 'POST' });
      if (res.ok) await fetchInsights();
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/insights/regenerate`, { method: 'POST' });
      if (res.ok) {
        setInsights(await res.json() as Insights);
        setNotFound(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const summary = insights?.summary;
  const soap = insights?.soap_note;

  return (
    <div className="mb-4 border border-indigo-200 bg-indigo-50 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-left min-h-[44px]"
        aria-expanded={expanded}
      >
        <span className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Session Insights (AI)
          {insights?.soap_status === 'reviewed' && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded">
              <CheckCircle size={12} /> SOAP reviewed
            </span>
          )}
        </span>
        <span className="text-xs text-indigo-400">therapist only</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 text-sm">
          {checkin && (
            <div>
              <h4 className="font-semibold text-gray-700 mb-1">Pre-session check-in</h4>
              <div className="bg-white rounded p-3 text-gray-700 space-y-1">
                {checkin.mood !== undefined && <div>Mood: <strong>{checkin.mood}/10</strong></div>}
                {checkin.topic && <div>On their mind: &ldquo;{checkin.topic}&rdquo;</div>}
                {checkin.goal && <div>Goal: &ldquo;{checkin.goal}&rdquo;</div>}
              </div>
            </div>
          )}

          {loading && <p className="text-gray-500">Loading insights…</p>}

          {notFound && !loading && (
            <div className="flex items-center gap-3">
              <p className="text-gray-500">No insights generated for this session yet.</p>
              {sessionStatus === 'ended' && (
                <button
                  onClick={handleRegenerate}
                  disabled={busy}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded text-xs font-medium"
                >
                  Generate now
                </button>
              )}
            </div>
          )}

          {summary && (
            <div>
              <h4 className="font-semibold text-gray-700 mb-1">
                Memory summary{summary.headline ? ` — “${summary.headline}”` : ''}
              </h4>
              <div className="bg-white rounded p-3 text-gray-700 space-y-1">
                {summary.topics && summary.topics.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {summary.topics.map(t => (
                      <span key={t} className="bg-indigo-100 text-indigo-800 text-xs px-2 py-0.5 rounded">{t}</span>
                    ))}
                  </div>
                )}
                {summary.mood_trajectory && <div>{summary.mood_trajectory}</div>}
                {summary.techniques_helped && summary.techniques_helped.length > 0 && (
                  <div>Helped: {summary.techniques_helped.join(', ')}</div>
                )}
                {summary.follow_up && <div className="text-gray-500">Follow-up: {summary.follow_up}</div>}
              </div>
            </div>
          )}

          {soap && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <h4 className="font-semibold text-gray-700">Draft SOAP note</h4>
                <div className="flex gap-2">
                  <button
                    onClick={handleRegenerate}
                    disabled={busy}
                    className="px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100 rounded flex items-center gap-1"
                    aria-label="Regenerate insights"
                  >
                    <RefreshCw size={12} /> Regenerate
                  </button>
                  {insights?.soap_status !== 'reviewed' && (
                    <button
                      onClick={handleReview}
                      disabled={busy}
                      className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded text-xs font-medium"
                    >
                      Mark reviewed
                    </button>
                  )}
                </div>
              </div>
              <div className="bg-white rounded p-3 text-gray-700 space-y-2">
                {(['subjective', 'objective', 'assessment', 'plan'] as const).map(k =>
                  soap[k] ? (
                    <div key={k}>
                      <span className="font-medium capitalize">{k}:</span> {soap[k]}
                    </div>
                  ) : null
                )}
                {insights?.soap_status === 'reviewed' && (
                  <p className="text-xs text-green-700 pt-1 border-t border-gray-100">
                    Reviewed by {insights.soap_reviewed_by}
                    {insights.soap_reviewed_at ? ` on ${new Date(insights.soap_reviewed_at).toLocaleString()}` : ''}
                  </p>
                )}
                <p className="text-xs text-gray-400">
                  AI-drafted ({insights?.model}) — verify before any clinical use.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
