// Clinician "Prep for next session" digest (ai-therapist-123), rendered
// inside SessionInsightsPanel for the session's participant. Structured,
// non-LLM checklist backed by /admin/api/users/:userId/prep. The server
// selects the tier by role (caseworker-portal spec section 10 item 2):
// therapists get the full checklist (clinician note, crisis flags, recent
// care notes); caseworkers get the summaries-only variant (engagement, open
// escalations, latest case note, safety-plan existence, recent AI
// summaries). Sections render purely from field presence, so each tier only
// ever shows what the server sent it.
import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Activity, CheckCircle, Circle, FileText, Shield } from 'react-feather';

interface PrepAssignment {
  id: number;
  title: string;
  description?: string;
  kind: string;
  suggested_frequency: string | null;
  status: string;
  assigned_at: string;
  completed_at: string | null;
  // Absent on the caseworker tier (participant-authored free text).
  completion_note?: string | null;
}

interface ScreenerDelta {
  scale: string;
  latest_score: number;
  latest_at: string;
  previous_score: number | null;
  delta: number | null;
  direction: 'up' | 'down' | 'unchanged' | null;
}

// Signed care notes (progress + case) surfaced by the caseworker-portal
// recent-notes card (slice B).
interface RecentNote {
  note_id: number;
  note_type: 'progress' | 'case';
  case_note_kind: string | null;
  author_name: string;
  author_role: 'therapist' | 'caseworker';
  signed_at: string | null;
  content: Record<string, string | undefined>;
}

// Caseworker-tier sections (summaries and signals only).
interface Engagement {
  last_session_at: string | null;
  ended_session_count: number;
  last_checkin_mood: number | null;
}

interface OpenEscalation {
  escalation_id: number;
  status: string;
  urgency: string;
  reason: string;
  raised_by_role: string;
  assigned_username: string | null;
  created_at: string;
}

interface RecentSummary {
  session_id: string;
  ended_at: string;
  summary: { headline?: string; follow_up?: string; topics?: string[] };
}

interface PrepDigest {
  tier?: 'therapist' | 'caseworker';
  open_assignments: PrepAssignment[];
  completed_assignments: PrepAssignment[];
  screener_deltas: ScreenerDelta[];
  // Therapist tier only.
  clinician_note?: { notes: string; author: string; created_at: string } | null;
  last_session?: { session_id: string; ended_at: string; headline: string | null; follow_up: string | null } | null;
  recent_crisis_flags?: { session_id: string; severity: string | null; flagged_at: string; unflagged_at: string | null }[];
  recent_notes?: RecentNote[];
  // Caseworker tier only.
  engagement?: Engagement | null;
  has_safety_plan?: boolean;
  open_escalations?: OpenEscalation[];
  latest_case_note?: RecentNote | null;
  recent_summaries?: RecentSummary[];
}

function noteSnippet(note: RecentNote): string {
  const text =
    note.note_type === 'case'
      ? note.content.narrative ?? ''
      : note.content.assessment || note.content.plan || note.content.subjective || '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
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

  const recentNotes = digest?.recent_notes ?? [];
  const crisisFlags = digest?.recent_crisis_flags ?? [];
  const openEscalations = digest?.open_escalations ?? [];
  const recentSummaries = digest?.recent_summaries ?? [];
  const isCaseworkerTier = digest?.tier === 'caseworker';
  const hasContent = digest && (
    digest.open_assignments.length > 0 || digest.completed_assignments.length > 0 ||
    digest.screener_deltas.length > 0 || (digest.clinician_note ?? null) !== null ||
    (digest.last_session ?? null) !== null || crisisFlags.length > 0 ||
    recentNotes.length > 0 || openEscalations.length > 0 || recentSummaries.length > 0 ||
    (digest.engagement ?? null) !== null || (digest.latest_case_note ?? null) !== null ||
    isCaseworkerTier
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

          {digest && openEscalations.length > 0 && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-red-600" aria-hidden="true" /> Open escalations
              </h5>
              <ul className="space-y-0.5 text-gray-700">
                {openEscalations.map(e => (
                  <li key={e.escalation_id}>
                    <span className="capitalize">{e.urgency}</span>: {e.reason}
                    <span className="text-xs text-gray-400">
                      {' '}
                      raised {shortDate(e.created_at)}
                      {e.assigned_username ? ` · assigned to ${e.assigned_username}` : ' · unassigned'}
                      {e.status === 'acknowledged' ? ' · acknowledged' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest && crisisFlags.length > 0 && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-red-600" aria-hidden="true" /> Recent crisis flags
              </h5>
              <ul className="space-y-0.5 text-gray-700">
                {crisisFlags.map((f, i) => (
                  <li key={i}>
                    {shortDate(f.flagged_at)}: {f.severity ?? 'unknown'} severity
                    {f.unflagged_at ? ' (resolved)' : ' (unresolved)'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest?.engagement && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
                <Activity size={14} aria-hidden="true" /> Engagement
              </h5>
              <p className="text-gray-700">
                {digest.engagement.last_session_at
                  ? <>Last session {shortDate(digest.engagement.last_session_at)}</>
                  : <>No sessions yet</>}
                {' · '}{digest.engagement.ended_session_count} completed session{digest.engagement.ended_session_count === 1 ? '' : 's'}
                {digest.engagement.last_checkin_mood !== null && (
                  <span className="text-gray-500"> · last check-in mood {digest.engagement.last_checkin_mood}</span>
                )}
              </p>
            </div>
          )}

          {isCaseworkerTier && (
            <p className={`flex items-center gap-1.5 ${digest?.has_safety_plan ? 'text-green-700' : 'text-gray-500'}`}>
              <Shield size={14} aria-hidden="true" />
              {digest?.has_safety_plan ? 'Safety plan on file' : 'No safety plan on file'}
            </p>
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

          {recentNotes.length > 0 && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
                <FileText size={14} aria-hidden="true" /> Recent notes
              </h5>
              <ul className="space-y-1.5 text-gray-700">
                {recentNotes.map(n => (
                  <li key={n.note_id}>
                    <span className="capitalize font-medium">
                      {n.note_type === 'case'
                        ? `${(n.case_note_kind ?? 'case').replace(/_/g, ' ')} note`
                        : 'Progress note'}
                    </span>
                    {noteSnippet(n) && <> — {noteSnippet(n)}</>}
                    <span className="text-xs text-gray-400">
                      {' '}
                      {n.author_name} ({n.author_role}){n.signed_at ? `, signed ${shortDate(n.signed_at)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest?.latest_case_note && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
                <FileText size={14} aria-hidden="true" /> Latest case note
              </h5>
              <p className="text-gray-700">
                <span className="capitalize font-medium">
                  {`${(digest.latest_case_note.case_note_kind ?? 'case').replace(/_/g, ' ')} note`}
                </span>
                {noteSnippet(digest.latest_case_note) && <> — {noteSnippet(digest.latest_case_note)}</>}
                <span className="text-xs text-gray-400">
                  {' '}
                  {digest.latest_case_note.author_name} ({digest.latest_case_note.author_role})
                  {digest.latest_case_note.signed_at ? `, signed ${shortDate(digest.latest_case_note.signed_at)}` : ''}
                </span>
              </p>
            </div>
          )}

          {recentSummaries.length > 0 && (
            <div>
              <h5 className="font-semibold text-gray-700 mb-1">Recent session summaries</h5>
              <ul className="space-y-1 text-gray-700">
                {recentSummaries.map(s => (
                  <li key={s.session_id}>
                    <span className="text-xs text-gray-400">{shortDate(s.ended_at)}</span>
                    {s.summary.headline && <> &ldquo;{s.summary.headline}&rdquo;</>}
                    {s.summary.follow_up && (
                      <span className="text-gray-500"> Follow-up: {s.summary.follow_up}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
