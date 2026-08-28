// Care-team panel inside SessionDetail: the participant's pre-session
// check-in, the AI memory summary, and the draft SOAP note with a review
// workflow. Backed by routes/admin/insights.routes.ts (403 for researchers —
// both artifacts derive from unredacted content). Caseworkers get the
// summaries-tier projection: the server omits the SOAP clinical-note draft
// from their GET (docs/caseworker-portal.md C6), so the SOAP/notes sections
// simply do not render. Therapists can additionally seed an authored progress
// note from the AI SOAP draft (slice B).
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, CheckCircle, FileText } from 'react-feather';
import PrepBrief from './PrepBrief';

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

// The therapist's authored progress note for this session (careNotes slice B).
interface AuthoredNote {
  note_id: number;
  status: 'draft' | 'signed' | 'amended';
  author_name: string;
  signed_at: string | null;
  seed_source: 'ai_soap' | null;
}

interface Insights {
  summary: SessionSummary | null;
  soap_note?: SoapNote | null;
  soap_status?: 'draft' | 'reviewed';
  soap_reviewed_by?: string | null;
  soap_reviewed_at?: string | null;
  model?: string | null;
  safety_plan?: { plan: Record<string, string[]>; created_at: string } | null;
  scale_responses?: { scale: string; answers: number[]; score: number; created_at: string }[];
  notes_for_next_session?: string | null;
  notes_author?: string | null;
  notes_created_at?: string | null;
  authored_note?: AuthoredNote | null;
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
  /** The session's participant, for the pre-session prep digest (null/absent = anonymous). */
  participantUserId?: number | null;
}

export default function SessionInsightsPanel({ sessionId, userRole, sessionStatus, checkin, participantUserId }: SessionInsightsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [notesSaved, setNotesSaved] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

  const isTherapist = userRole === 'therapist';
  const isCaseworker = userRole === 'caseworker';
  const canView = isTherapist || isCaseworker;

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/insights`);
      if (res.ok) {
        const data = await res.json() as Insights;
        setInsights(data);
        setNotesDraft(data.notes_for_next_session ?? '');
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
    if (canView && expanded && !insights) void fetchInsights();
  }, [canView, expanded, insights, fetchInsights]);

  if (!canView) return null;
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

  const handleSaveNotes = async () => {
    setBusy(true);
    setNotesSaved(false);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/insights/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesDraft }),
      });
      if (res.ok) {
        setInsights(prev => (prev ? { ...prev, notes_for_next_session: notesDraft } : prev));
        setNotesSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  // Seed an authored progress note from the AI SOAP draft (idempotent server
  // side: an existing live note for the session is returned instead).
  const handleSeedNote = async () => {
    setBusy(true);
    setSeedError(null);
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/notes/from-insights`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to start the progress note');
      setInsights(prev => (prev ? { ...prev, authored_note: (data as { note: AuthoredNote }).note } : prev));
    } catch (err: unknown) {
      setSeedError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = insights?.summary;
  const soap = insights?.soap_note;
  const authoredNote = insights?.authored_note ?? null;

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
        <span className="text-xs text-indigo-400">{isCaseworker ? 'summary view' : 'therapist only'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 text-sm">
          {/* Structured pre-session prep digest (ai-therapist-123), keyed by
              participant — only for logged-in participants. Therapist-only:
              the digest quotes clinician notes and crisis history. */}
          {isTherapist && typeof participantUserId === 'number' && <PrepBrief userId={participantUserId} />}

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
              {isTherapist && sessionStatus === 'ended' && (
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

          {insights?.safety_plan && (
            <div>
              <h4 className="font-semibold text-gray-700 mb-1">
                Safety plan <span className="font-normal text-xs text-gray-400">created {new Date(insights.safety_plan.created_at).toLocaleString()}</span>
              </h4>
              <div className="bg-white rounded p-3 text-gray-700 space-y-2">
                {Object.entries(insights.safety_plan.plan).map(([section, items]) =>
                  Array.isArray(items) && items.length > 0 ? (
                    <div key={section}>
                      <span className="font-medium capitalize">{section.replace(/_/g, ' ')}:</span>{' '}
                      {items.join('; ')}
                    </div>
                  ) : null
                )}
              </div>
            </div>
          )}

          {insights?.scale_responses && insights.scale_responses.length > 0 && (
            <div>
              <h4 className="font-semibold text-gray-700 mb-1">Screener responses</h4>
              <div className="bg-white rounded p-3 text-gray-700 space-y-1">
                {insights.scale_responses.map((r, i) => (
                  <div key={i}>
                    <span className="font-mono uppercase">{r.scale}</span>: score <strong>{r.score}</strong>
                    {' '}(items: {r.answers.join(', ')}) · {new Date(r.created_at).toLocaleString()}
                    {r.score >= 3 && <span className="ml-2 text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">≥ cutoff</span>}
                  </div>
                ))}
                <p className="text-xs text-gray-400 pt-1">Screeners, not diagnoses.</p>
              </div>
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

                {/* Progress-note seeding (slice B): one live authored note per
                    session; the server is idempotent about it. */}
                <div className="pt-2 border-t border-gray-100">
                  {authoredNote ? (
                    <p className="text-xs text-gray-600 flex items-center gap-1.5">
                      <FileText size={12} aria-hidden="true" />
                      Progress note {authoredNote.status === 'signed' ? 'signed' : `in ${authoredNote.status}`} by{' '}
                      {authoredNote.author_name}
                      {authoredNote.signed_at ? ` on ${new Date(authoredNote.signed_at).toLocaleString()}` : ''} — see
                      the client&apos;s Notes panel.
                    </p>
                  ) : (
                    <button
                      onClick={handleSeedNote}
                      disabled={busy}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded text-xs font-medium flex items-center gap-1.5"
                    >
                      <FileText size={12} aria-hidden="true" /> Start progress note from this draft
                    </button>
                  )}
                  {seedError && <p className="text-xs text-red-600 mt-1" role="alert">{seedError}</p>}
                </div>
              </div>
            </div>
          )}

          {isTherapist && insights && (
            <div>
              <h4 className="font-semibold text-gray-700 mb-1">Notes for next session</h4>
              <div className="bg-white rounded p-3 space-y-2">
                <textarea
                  value={notesDraft}
                  onChange={e => { setNotesDraft(e.target.value); setNotesSaved(false); }}
                  placeholder="Guidance for the AI in this participant's next session (private — never shown to them)…"
                  maxLength={1000}
                  rows={3}
                  className="w-full text-sm border border-gray-200 rounded p-2 text-gray-700"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSaveNotes}
                    disabled={busy}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded text-xs font-medium"
                  >
                    Save notes
                  </button>
                  {notesSaved && <span className="text-xs text-green-700">Saved</span>}
                  {insights.notes_author && (
                    <span className="text-xs text-gray-400">
                      last set by {insights.notes_author}
                      {insights.notes_created_at ? ` on ${new Date(insights.notes_created_at).toLocaleString()}` : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
