// Between-sessions Home (ai-therapist-121): what a logged-in participant sees
// when no session is active — a practice companion surface with their own
// check-in trends, worksheets, and safety plan. Everything here fails soft:
// any endpoint error just hides that card, and the Start controls (rendered
// by App below this view, always visible) are never blocked on progress data.
//
// Charts are deliberately lightweight inline SVG sparklines, not Recharts:
// the main participant bundle doesn't ship Recharts today (only the admin
// client does), and these tiny labeled small-multiples don't justify adding it.
import { useEffect, useState } from 'react';
import { TrendingUp, FileText, Shield, ChevronRight, Phone, Target, CheckCircle, MessageSquare } from 'react-feather';
import { Shell, SafetyPlanCard, type SafetyPlanData, type CustomWorksheetSection } from './ToolOverlays';

// ---------- server payload shapes (dates arrive as ISO strings) ----------

interface ScalePoint {
  scale: string;
  score: number;
  created_at: string;
}

interface MoodPoint {
  date: string;
  source: 'checkin' | 'log_mood';
  mood: number;
}

interface OwnProgress {
  session_count: number;
  last_session_at: string | null;
  scale_history: ScalePoint[];
  mood_trajectory: MoodPoint[];
  weekly_sessions: { week_start: string; sessions: number }[];
  has_safety_plan: boolean;
}

interface WorksheetItem {
  instance_id: number;
  title: string;
  template_title: string | null;
  intro: string | null;
  sections: CustomWorksheetSection[];
  responses: Record<string, string> | null;
  status: 'draft' | 'completed';
  created_at: string;
  completed_at: string | null;
}

interface AssignmentItem {
  id: number;
  title: string;
  description: string;
  kind: 'worksheet' | 'exercise' | 'observation' | 'custom';
  suggested_frequency: string | null;
  status: 'assigned' | 'completed' | 'skipped';
  assigned_at: string;
  completed_at: string | null;
  completion_note: string | null;
}

// ---------- small helpers ----------

/** "today", "yesterday", a weekday name within the last week, else a date. */
function friendlyDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- sparkline (inline SVG, one labeled row per measure) ----------

function Sparkline({ values, min, max }: { values: number[]; min: number; max: number }) {
  // Wide viewBox so the stretch factor under preserveAspectRatio="none" stays
  // near 1 at typical card widths (keeps the endpoint dot close to circular).
  const W = 300;
  const H = 36;
  const PAD = 6; // keeps the 2px stroke and endpoint dot inside the viewBox
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (values.length - 1));
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-9" aria-hidden="true" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke="#2563eb"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r="4" fill="#2563eb" stroke="#ffffff" strokeWidth="2" />
    </svg>
  );
}

/** One labeled trend row: name + sparkline + latest value (text stays in ink
 *  tokens; the mark alone carries the series). Values are oldest -> newest. */
function TrendRow({ label, values, min, max, latestLabel, dateRange }: {
  label: string; values: number[]; min: number; max: number; latestLabel: string; dateRange: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 flex-shrink-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="text-xs text-gray-400">{dateRange}</p>
      </div>
      <div className="flex-1 min-w-0">
        <Sparkline values={values} min={min} max={max} />
      </div>
      <p className="w-14 flex-shrink-0 text-right text-sm text-gray-600 tabular-nums">{latestLabel}</p>
    </div>
  );
}

// ---------- practice assignments card ----------

/** Open practice with a "Mark done" flow (+ optional short note); anything
 *  completed in the last week stays visible, checked, for the small win. */
function PracticeCard({ assignments, onCompleted }: {
  assignments: AssignmentItem[];
  onCompleted: (updated: AssignmentItem) => void;
}) {
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const open = assignments.filter(a => a.status === 'assigned');
  const weekAgo = Date.now() - 7 * 86_400_000;
  const doneThisWeek = assignments.filter(
    a => a.status === 'completed' && a.completed_at !== null && new Date(a.completed_at).getTime() >= weekAgo
  );
  if (open.length === 0 && doneThisWeek.length === 0) return null;

  const markDone = async (assignment: AssignmentItem, note: string) => {
    setBusyId(assignment.id);
    try {
      const res = await fetch(`/api/me/assignments/${assignment.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
      });
      if (res.ok) {
        const data = await res.json() as { assignment: AssignmentItem };
        onCompleted(data.assignment);
        setNoteFor(null);
        setNoteText('');
      }
    } catch {
      /* leave the item as-is; they can try again */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-5 sm:p-6">
      <div className="flex items-center gap-2 mb-3">
        <Target size={18} className="text-blue-600" aria-hidden="true" />
        <h3 className="text-base font-semibold text-gray-800">Your practice</h3>
      </div>
      {open.length > 0 && (
        <p className="text-sm text-gray-500 mb-2">
          What you and your AI companion agreed to try between conversations.
        </p>
      )}
      <ul className="divide-y divide-gray-100">
        {open.map(a => (
          <li key={a.id} className="py-3 space-y-2">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800">{a.title}</p>
                <p className="text-sm text-gray-500">{a.description}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  From your conversation {friendlyDay(a.assigned_at)}
                  {a.suggested_frequency ? ` · ${a.suggested_frequency}` : ''}
                </p>
              </div>
              {noteFor !== a.id && (
                <button
                  onClick={() => { setNoteFor(a.id); setNoteText(''); }}
                  disabled={busyId !== null}
                  className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white min-h-[36px]"
                >
                  Mark done
                </button>
              )}
            </div>
            {noteFor === a.id && (
              <div className="space-y-2">
                <input
                  type="text"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  maxLength={500}
                  placeholder="How did it go? (optional)"
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void markDone(a, noteText)}
                    disabled={busyId !== null}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white min-h-[36px]"
                  >
                    {busyId === a.id ? 'Saving…' : 'Done'}
                  </button>
                  <button
                    onClick={() => { setNoteFor(null); setNoteText(''); }}
                    disabled={busyId !== null}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg text-gray-500 hover:bg-gray-50 min-h-[36px]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
        {doneThisWeek.map(a => (
          <li key={a.id} className="py-3 flex items-start gap-3">
            <CheckCircle size={16} className="text-green-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-500 line-through decoration-gray-300">{a.title}</p>
              <p className="text-xs text-gray-400">
                Done {a.completed_at ? friendlyDay(a.completed_at) : ''}
                {a.completion_note ? ` — "${a.completion_note}"` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-400 mt-2">
        No pressure — practice is something to notice, not a score. You can talk through any of it next time.
      </p>
    </div>
  );
}

// ---------- read-only worksheet view ----------

function WorksheetReadOnly({ worksheet, onClose }: { worksheet: WorksheetItem; onClose: () => void }) {
  return (
    <Shell title={worksheet.title} onClose={onClose} wide>
      <div className="px-6 py-5 space-y-4">
        <p className="text-xs text-gray-400">
          {worksheet.status === 'completed'
            ? `Completed ${shortDate(worksheet.completed_at ?? worksheet.created_at)}`
            : `Started ${shortDate(worksheet.created_at)} — not finished`}
        </p>
        {worksheet.intro && <p className="text-sm text-gray-600 italic">{worksheet.intro}</p>}
        {worksheet.sections.map((section, i) => {
          const answer = worksheet.responses?.[`s${i}`];
          return (
            <div key={`${section.label}-${i}`}>
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">{section.label}</p>
              {answer !== undefined && answer !== '' ? (
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {section.type === 'scale' ? `${answer} / 100` : answer}
                </p>
              ) : (
                <p className="text-sm text-gray-400 italic">Not filled in</p>
              )}
            </div>
          );
        })}
        <p className="text-xs text-gray-400 text-center pt-1">
          This is a read-only copy of what you worked on. You can revisit it in your next conversation.
        </p>
      </div>
    </Shell>
  );
}

// ---------- the home view ----------

interface HomeProps {
  /** Open the async-messaging view (caseworker portal). */
  onOpenMessages?: () => void;
  messagesUnread?: number;
}

export default function Home({ onOpenMessages, messagesUnread = 0 }: HomeProps = {}) {
  // null = still checking; false = anonymous (keep the plain start prompt).
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  // Messages card data: hidden for anonymous users and when there are no
  // threads yet (threads are created by the care team, not the participant).
  const [threadCount, setThreadCount] = useState(0);
  const [progress, setProgress] = useState<OwnProgress | null>(null);
  const [worksheets, setWorksheets] = useState<WorksheetItem[] | null>(null);
  const [assignments, setAssignments] = useState<AssignmentItem[] | null>(null);
  const [safetyPlan, setSafetyPlan] = useState<SafetyPlanData | null>(null);
  const [openWorksheet, setOpenWorksheet] = useState<WorksheetItem | null>(null);
  const [showSafetyPlan, setShowSafetyPlan] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Fail-soft loading: each fetch is independent; an error simply leaves
    // that card hidden. Nothing here gates the Start controls below.
    fetch('/api/auth/status', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled) return;
        const isAuthed = Boolean(data?.authenticated);
        setAuthenticated(isAuthed);
        if (!isAuthed) return;

        fetch('/api/me/progress', { credentials: 'include' })
          .then(res => (res.ok ? res.json() : null))
          .then((p: OwnProgress | null) => { if (!cancelled && p) setProgress(p); })
          .catch(() => { /* card stays hidden */ });

        fetch('/api/me/assignments', { credentials: 'include' })
          .then(res => (res.ok ? res.json() : null))
          .then((d: { assignments: AssignmentItem[] } | null) => {
            if (!cancelled && d && Array.isArray(d.assignments)) setAssignments(d.assignments);
          })
          .catch(() => { /* card stays hidden */ });

        fetch('/api/me/worksheets', { credentials: 'include' })
          .then(res => (res.ok ? res.json() : null))
          .then((d: { worksheets: WorksheetItem[] } | null) => {
            if (!cancelled && d && Array.isArray(d.worksheets)) setWorksheets(d.worksheets);
          })
          .catch(() => { /* card stays hidden */ });

        fetch('/api/messaging/threads', { credentials: 'include' })
          .then(res => (res.ok ? res.json() : null))
          .then((d: { threads: unknown[] } | null) => {
            if (!cancelled && d && Array.isArray(d.threads)) setThreadCount(d.threads.length);
          })
          .catch(() => { /* card stays hidden */ });

        fetch('/api/me/safety-plan', { credentials: 'include' })
          .then(res => (res.ok ? res.json() : null))
          .then((d: { safety_plan: { plan: SafetyPlanData } | null } | null) => {
            if (!cancelled && d?.safety_plan?.plan) setSafetyPlan(d.safety_plan.plan);
          })
          .catch(() => { /* card stays hidden */ });
      })
      .catch(() => { if (!cancelled) setAuthenticated(false); });

    return () => { cancelled = true; };
  }, []);

  // Anonymous participants (and the brief auth check) keep the existing
  // minimal start prompt — their session data isn't linked to an account.
  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-full text-center px-4">
        <div className="w-full max-w-2xl">
          <p className="text-gray-500 text-xl">
            Press &quot;Start Session&quot; to begin your conversation with the AI Therapist.
          </p>
        </div>
      </div>
    );
  }

  // Trend rows, oldest -> newest for left-to-right time.
  const phq = progress
    ? progress.scale_history.filter(p => p.scale.toLowerCase().includes('phq')).slice().reverse()
    : [];
  const gad = progress
    ? progress.scale_history.filter(p => p.scale.toLowerCase().includes('gad')).slice().reverse()
    : [];
  const mood = progress ? progress.mood_trajectory.slice().reverse() : [];
  const hasTrends = phq.length >= 2 || gad.length >= 2 || mood.length >= 2;
  const isFirstTime = progress !== null && progress.session_count === 0;
  const recentWeeks = progress ? progress.weekly_sessions.slice(-8) : [];
  const maxWeekly = Math.max(1, ...recentWeeks.map(w => w.sessions));

  const rangeLabel = (first: string, last: string) => `${shortDate(first)} – ${shortDate(last)}`;

  return (
    <div className="w-full max-w-2xl mx-auto px-1 sm:px-4 py-4 space-y-4">
      {/* Header: welcome + gentle continuity line */}
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-gray-800">Welcome back</h2>
        {progress && progress.session_count > 0 && (
          <p className="text-gray-500 mt-1">
            {progress.session_count} conversation{progress.session_count === 1 ? '' : 's'}
            {progress.last_session_at ? ` · last one ${friendlyDay(progress.last_session_at)}` : ''}
          </p>
        )}
        <p className="text-sm text-gray-400 mt-1">
          Your practice companion between sessions — press Start Session below whenever you&apos;re ready.
        </p>
      </div>

      {/* Messages card (caseworker portal): shown only when the care team has
          opened at least one thread with this participant. */}
      {onOpenMessages && threadCount > 0 && (
        <button
          onClick={onOpenMessages}
          className="w-full bg-white rounded-2xl shadow p-5 sm:p-6 text-left hover:shadow-md transition flex items-center gap-3"
          aria-label={`Open messages${messagesUnread > 0 ? `, ${messagesUnread} unread` : ''}`}
        >
          <MessageSquare size={20} className="text-blue-600 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-gray-800">Messages</p>
            <p className="text-sm text-gray-500">
              {messagesUnread > 0
                ? `${messagesUnread} unread message${messagesUnread === 1 ? '' : 's'} from your care team`
                : 'Check in with your care team between sessions'}
            </p>
          </div>
          {messagesUnread > 0 && (
            <span className="bg-red-500 text-white text-xs font-bold rounded-full min-w-[22px] h-[22px] px-1.5 flex items-center justify-center shrink-0">
              {messagesUnread > 99 ? '99+' : messagesUnread}
            </span>
          )}
          <ChevronRight size={18} className="text-gray-400 shrink-0" aria-hidden="true" />
        </button>
      )}

      {/* First-time empty state: warm explainer, no fake content */}
      {isFirstTime && (
        <div className="bg-white rounded-2xl shadow p-6 text-center">
          <p className="text-gray-700 font-medium">This space is yours.</p>
          <p className="text-sm text-gray-500 mt-1">
            After your first conversation, you&apos;ll see your progress here — how you&apos;ve been
            feeling over time, anything you work on, and tools you can come back to.
          </p>
        </div>
      )}

      {/* Your progress */}
      {progress && progress.session_count > 0 && (hasTrends || recentWeeks.some(w => w.sessions > 0)) && (
        <div className="bg-white rounded-2xl shadow p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={18} className="text-blue-600" aria-hidden="true" />
            <h3 className="text-base font-semibold text-gray-800">Your progress</h3>
          </div>
          <div className="space-y-4">
            {phq.length >= 2 && (
              <TrendRow
                label="Mood check-in"
                values={phq.map(p => p.score)}
                min={0}
                max={6}
                latestLabel={`${phq[phq.length - 1].score}/6`}
                dateRange={rangeLabel(phq[0].created_at, phq[phq.length - 1].created_at)}
              />
            )}
            {gad.length >= 2 && (
              <TrendRow
                label="Worry check-in"
                values={gad.map(p => p.score)}
                min={0}
                max={6}
                latestLabel={`${gad[gad.length - 1].score}/6`}
                dateRange={rangeLabel(gad[0].created_at, gad[gad.length - 1].created_at)}
              />
            )}
            {mood.length >= 2 && (
              <TrendRow
                label="How you felt"
                values={mood.map(p => p.mood)}
                min={1}
                max={10}
                latestLabel={`${mood[mood.length - 1].mood}/10`}
                dateRange={rangeLabel(mood[0].date, mood[mood.length - 1].date)}
              />
            )}
            {recentWeeks.some(w => w.sessions > 0) && (
              <div className="pt-1">
                <p className="text-sm font-medium text-gray-700 mb-1.5">Recent weeks</p>
                <div className="flex items-end gap-1.5 h-8" role="img"
                  aria-label={`Conversations per week over the last ${recentWeeks.length} weeks`}>
                  {recentWeeks.map(w => (
                    <div
                      key={w.week_start}
                      title={`Week of ${shortDate(w.week_start)}: ${w.sessions} conversation${w.sessions === 1 ? '' : 's'}`}
                      className={`flex-1 rounded-t ${w.sessions > 0 ? 'bg-blue-500' : 'bg-gray-100'}`}
                      style={{ height: `${Math.max(12, (w.sessions / maxWeekly) * 100)}%` }}
                    />
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">Conversations per week, last {recentWeeks.length} weeks</p>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-4">
            These are brief check-ins over time, not a diagnosis or a grade.
          </p>
        </div>
      )}

      {/* Your practice (between-session assignments) */}
      {assignments !== null && (
        <PracticeCard
          assignments={assignments}
          onCompleted={updated =>
            setAssignments(prev => (prev ? prev.map(a => (a.id === updated.id ? updated : a)) : prev))
          }
        />
      )}

      {/* Your worksheets */}
      {worksheets !== null && worksheets.length > 0 && (
        <div className="bg-white rounded-2xl shadow p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-3">
            <FileText size={18} className="text-blue-600" aria-hidden="true" />
            <h3 className="text-base font-semibold text-gray-800">Your worksheets</h3>
          </div>
          <ul className="divide-y divide-gray-100">
            {worksheets.map(w => (
              <li key={w.instance_id}>
                <button
                  onClick={() => setOpenWorksheet(w)}
                  className="w-full flex items-center gap-3 py-3 text-left hover:bg-gray-50 rounded-lg px-2 -mx-2 min-h-[44px]"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{w.title}</p>
                    <p className="text-xs text-gray-400">{shortDate(w.created_at)}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
                    w.status === 'completed' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
                  }`}>
                    {w.status === 'completed' ? 'Completed' : 'Draft'}
                  </span>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Your safety plan (only if one exists) */}
      {safetyPlan && (
        <div className="bg-white rounded-2xl shadow p-5 sm:p-6">
          <button
            onClick={() => setShowSafetyPlan(true)}
            className="w-full flex items-center gap-3 text-left min-h-[44px]"
          >
            <Shield size={18} className="text-blue-600 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-gray-800">Your safety plan</h3>
              <p className="text-xs text-gray-400">Tap to review it any time — it&apos;s here when you need it.</p>
            </div>
            <ChevronRight size={16} className="text-gray-300 flex-shrink-0" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Crisis footer — same visual language as the rest of the app */}
      <div className="bg-red-50 rounded-2xl p-4 flex items-center gap-3">
        <Phone size={16} className="text-red-500 flex-shrink-0" aria-hidden="true" />
        <p className="text-sm text-red-900">
          If things feel unsafe, call or text <a href="tel:988" className="font-semibold underline">988</a> — the
          Suicide &amp; Crisis Lifeline — any time, day or night.
        </p>
      </div>

      {/* Read-only overlays */}
      {openWorksheet && (
        <WorksheetReadOnly worksheet={openWorksheet} onClose={() => setOpenWorksheet(null)} />
      )}
      {showSafetyPlan && safetyPlan && (
        <SafetyPlanCard plan={safetyPlan} onClose={() => setShowSafetyPlan(false)} />
      )}
    </div>
  );
}
