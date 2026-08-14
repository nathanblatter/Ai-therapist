// Clinician "Prep for next session" digest (ai-therapist-123), rendered
// inside SessionInsightsPanel for the session's participant. Structured,
// non-LLM checklist backed by /admin/api/users/:userId/prep — the quick scan
// a therapist does right before a session: open practice, screener movement,
// last follow-up, latest clinician note, recent crisis flags.
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, CheckCircle, Circle } from 'react-feather';

interface PrepAssignment {
  id: number;
  title: string;
  description: string;
  kind: string;
  suggested_frequency: string | null;
  status: string;
  assigned_at: string;
  completed_at: string | null;
  completion_note: string | null;
}

interface ScreenerDelta {
  scale: string;
  latest_score: number;
  latest_at: string;
  previous_score: number | null;
  delta: number | null;
  direction: 'up' | 'down' | 'unchanged' | null;
}

interface PrepDigest {
  open_assignments: PrepAssignment[];
  completed_assignments: PrepAssignment[];
  screener_deltas: ScreenerDelta[];
  clinician_note: { notes: string; author: string; created_at: string } | null;
  last_session: { session_id: string; ended_at: string; headline: string | null; follow_up: string | null } | null;
  recent_crisis_flags: { session_id: string; severity: string | null; flagged_at: string; unflagged_at: string | null }[];
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function PrepBrief({ userId }: { userId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [digest, setDigest] = useState<PrepDigest | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const fetchDigest = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/admin/api/users/${userId}/prep`);
      if (res.ok) {
        setDigest(await res.json() as PrepDigest);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (expanded && !digest) void fetchDigest();
  }, [expanded, digest, fetchDigest]);

  const hasContent = digest && (
    digest.open_assignments.length > 0 || digest.completed_assignments.length > 0 ||
    digest.screener_deltas.length > 0 || digest.clinician_note !== null ||
    digest.last_session !== null || digest.recent_crisis_flags.length > 0
  );

  return (
    <div className="border border-gray-200 bg-white rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-left min-h-[44px]"
        aria-expanded={expanded}
      >
        <span className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Prep for next session
        </span>
        <span className="text-xs text-gray-400">structured digest</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 text-sm">
          {loading && <p className="text-gray-500">Loading prep digest…</p>}
          {failed && !loading && <p className="text-gray-500">Could not load the prep digest.</p>}
          {digest && !hasContent && (
            <p className="text-gray-500">Nothing on file for this participant yet.</p>
          )}

          {digest && digest.recent_crisis_flags.length > 0 && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-red-600" aria-hidden="true" /> Recent crisis flags
              </h5>
              <ul className="space-y-0.5 text-gray-700">
                {digest.recent_crisis_flags.map((f, i) => (
                  <li key={i}>
                    {shortDate(f.flagged_at)}: {f.severity ?? 'unknown'} severity
                    {f.unflagged_at ? ' (resolved)' : ' (unresolved)'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest && (digest.open_assignments.length > 0 || digest.completed_assignments.length > 0) && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1">Practice assignments</h5>
              <ul className="space-y-1 text-gray-700">
                {digest.open_assignments.map(a => (
                  <li key={a.id} className="flex items-start gap-1.5">
                    <Circle size={13} className="text-amber-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      {a.title} <span className="text-xs text-gray-400">assigned {shortDate(a.assigned_at)}{a.suggested_frequency ? ` · ${a.suggested_frequency}` : ''}</span>
                    </span>
                  </li>
                ))}
                {digest.completed_assignments.map(a => (
                  <li key={a.id} className="flex items-start gap-1.5">
                    <CheckCircle size={13} className="text-green-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      {a.title}
                      {a.completed_at && <span className="text-xs text-gray-400"> done {shortDate(a.completed_at)}</span>}
                      {a.completion_note && <span className="text-xs text-gray-500 italic"> — &ldquo;{a.completion_note}&rdquo;</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest && digest.screener_deltas.length > 0 && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1">Screener movement</h5>
              <ul className="space-y-0.5 text-gray-700">
                {digest.screener_deltas.map(d => (
                  <li key={d.scale}>
                    <span className="font-mono uppercase">{d.scale}</span>: <strong>{d.latest_score}</strong>
                    {d.previous_score !== null
                      ? <> (was {d.previous_score} — {d.direction})</>
                      : <span className="text-xs text-gray-400"> first recorded</span>}
                    <span className="text-xs text-gray-400"> · {shortDate(d.latest_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest?.last_session && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1">
                Last session <span className="font-normal text-xs text-gray-400">{shortDate(digest.last_session.ended_at)}</span>
              </h5>
              <div className="text-gray-700">
                {digest.last_session.headline && <p>&ldquo;{digest.last_session.headline}&rdquo;</p>}
                {digest.last_session.follow_up
                  ? <p className="text-gray-500">Open follow-up: {digest.last_session.follow_up}</p>
                  : <p className="text-xs text-gray-400">No open follow-up recorded.</p>}
              </div>
            </div>
          )}

          {digest?.clinician_note && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1">Latest clinician note</h5>
              <p className="text-gray-700">
                &ldquo;{digest.clinician_note.notes}&rdquo;{' '}
                <span className="text-xs text-gray-400">
                  {digest.clinician_note.author}, {shortDate(digest.clinician_note.created_at)}
                </span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
