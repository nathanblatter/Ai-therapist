// Participant profile v2 (ai-therapist-122): answers the clinician's three
// questions in reading order — "How is this person doing?" (status strip),
// "What changed recently?" (AI brief + unified timeline), "What should I know
// before their next session?" (timeline detail + collapsed clinical drawer).
// Opened from the Users table; session entries open SessionDetail on top.
import { useState, useEffect, useMemo } from 'react';
import {
  X, User, Cpu, Shield, AlertTriangle, TrendingUp, TrendingDown, Minus,
  MessageCircle, List, Lock, BookOpen, Heart, FileText, Calendar, Activity,
} from 'react-feather';
import Panel from './ui/Panel';
import StatCard from './ui/StatCard';
import useAdminFetch from '../hooks/useAdminFetch';
import NotesPanel from './notes/NotesPanel';
import MyEscalations from './escalations/MyEscalations';
import MessageThreadView from './MessageThreadView';

interface ProfileUser {
  userid: number;
  username: string;
  role: string;
  preferred_voice?: string | null;
  preferred_language?: string | null;
  mfa_enabled?: boolean;
  memory_enabled?: boolean;
  risk_context_share_enabled?: boolean;
  created_at?: string | null;
}

interface SessionSummary {
  headline?: string;
  topics?: string[];
  mood_trajectory?: string;
  techniques_helped?: string[];
  follow_up?: string;
}

interface CaseProfile {
  presenting_concerns?: string[];
  recurring_themes?: string[];
  stressors?: string[];
  support_system?: string[];
  coping_repertoire?: { technique: string; helpfulness: string }[];
  values?: string[];
  screener_trend?: string;
}

interface ProfileBundle {
  user: ProfileUser;
  memory_enabled: boolean;
  risk_context_share_enabled: boolean;
  summaries: { session_id: string; summary: SessionSummary; session_name: string | null; ended_at: string | null; created_at: string }[];
  ended_session_count: number;
  memories: { fact: string; session_id: string | null; created_at: string }[];
  case_profile: { profile: CaseProfile; updated_at: string } | null;
  scale_history: { scale: string; score: number; created_at: string; session_id: string }[];
  mood_trajectory: { date: string; source: string; mood: number }[];
  safety_plan: { plan: Record<string, string[] | undefined>; created_at: string; session_id: string | null } | null;
  thought_record: { record: Record<string, string | undefined>; created_at: string } | null;
  clinician_note: { notes: string; author: string | null; created_at: string; session_id: string } | null;
  prior_crisis_flags: { session_id: string; severity: string | null; flagged_at: string; unflagged_at: string | null; unflagged_by: string | null }[];
}

interface UserSessionRow {
  session_id: string;
  session_name: string | null;
  status: string;
  start_time: string;
  end_time: string | null;
  ended_by: string | null;
  crisis_flagged: boolean;
  crisis_severity: string | null;
  duration_seconds: number | null;
  total_messages: number;
  eval_score: number | null;
  feedback_rating: number | null;
}

interface ParticipantProfileProps {
  user: ProfileUser;
  userRole: string | null;
  onClose: () => void;
  onViewSession: (sessionId: string) => void;
  /** Navigate the admin shell (e.g. 'escalations'); closes the profile. */
  onNavigate?: (view: string) => void;
}

// ---------- helpers ----------

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString() : '—';
}

function relativeDate(value: string | null | undefined): string {
  if (!value) return '—';
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
  const s = Math.round(Number(seconds));
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type Trend = 'improving' | 'worsening' | 'flat';

/** Trend over the last 3 points; `higherIsBetter` flips the reading. */
function computeTrend(values: number[], higherIsBetter: boolean): Trend {
  const recent = values.slice(-3);
  if (recent.length < 2) return 'flat';
  const delta = recent[recent.length - 1] - recent[0];
  if (delta === 0) return 'flat';
  return (delta > 0) === higherIsBetter ? 'improving' : 'worsening';
}

const TREND_META: Record<Trend, { icon: typeof Minus; tone: string; label: string }> = {
  improving: { icon: TrendingUp, tone: 'text-emerald-600', label: 'improving' },
  worsening: { icon: TrendingDown, tone: 'text-red-600', label: 'worsening' },
  flat: { icon: Minus, tone: 'text-gray-400', label: 'flat' },
};

function Sparkline({ values, max }: { values: number[]; max: number }) {
  if (values.length < 2) return null;
  const w = 72, h = 22, pad = 2;
  const points = values
    .map((v, i) => `${pad + (i * (w - 2 * pad)) / (values.length - 1)},${h - pad - (Math.min(v, max) / max) * (h - 2 * pad)}`)
    .join(' ');
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-royal" />
    </svg>
  );
}

/** Compact status-strip tile: value + trend arrow + inline sparkline. */
function TrendTile({ label, values, max, higherIsBetter, unit, empty }: {
  label: string; values: number[]; max: number; higherIsBetter: boolean; unit?: string; empty: string;
}) {
  if (values.length === 0) {
    return (
      <Panel className="!p-4">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm text-gray-400 mt-2">{empty}</p>
      </Panel>
    );
  }
  const trend = computeTrend(values, higherIsBetter);
  const { icon: Icon, tone, label: trendLabel } = TREND_META[trend];
  return (
    <Panel className="!p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <div className="flex items-end justify-between gap-2 mt-1">
        <p className="text-2xl font-bold text-navy">
          {values[values.length - 1]}{unit && <span className="text-sm font-normal text-gray-400">{unit}</span>}
        </p>
        <Sparkline values={values} max={max} />
      </div>
      <p className={`text-xs mt-1 inline-flex items-center gap-1 ${tone}`}>
        <Icon size={12} /> {trendLabel}
      </p>
    </Panel>
  );
}

function TagList({ items, tone = 'bg-gray-100 text-gray-700' }: { items: string[]; tone?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => <span key={item} className={`px-2 py-0.5 rounded text-xs ${tone}`}>{item}</span>)}
    </div>
  );
}

function DrawerSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="border-b border-gray-100 last:border-b-0 py-2 group">
      <summary className="cursor-pointer text-sm font-semibold text-gray-700 hover:text-gray-900 select-none list-none flex items-center justify-between">
        {title}
        <span className="text-gray-400 text-xs group-open:hidden">show</span>
        <span className="text-gray-400 text-xs hidden group-open:inline">hide</span>
      </summary>
      <div className="mt-2 text-sm text-gray-700">{children}</div>
    </details>
  );
}

// ---------- timeline ----------

type TimelineEvent =
  | { kind: 'session'; date: string; session: UserSessionRow; summary: SessionSummary | null }
  | { kind: 'summary'; date: string; sessionId: string; name: string | null; summary: SessionSummary }
  | { kind: 'crisis'; date: string; sessionId: string; severity: string | null; resolvedAt: string | null; resolvedBy: string | null }
  | { kind: 'note'; date: string; author: string | null; notes: string }
  | { kind: 'safety'; date: string; sessionId: string | null }
  | { kind: 'worksheet'; date: string; record: Record<string, string | undefined> };

function buildTimeline(profile: ProfileBundle | null, sessions: UserSessionRow[] | null): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const summariesById = new Map((profile?.summaries ?? []).map(s => [s.session_id, s]));
  const sessionIds = new Set<string>();

  for (const s of sessions ?? []) {
    sessionIds.add(s.session_id);
    events.push({ kind: 'session', date: s.start_time, session: s, summary: summariesById.get(s.session_id)?.summary ?? null });
  }
  for (const row of profile?.summaries ?? []) {
    if (!sessionIds.has(row.session_id)) {
      events.push({ kind: 'summary', date: row.ended_at ?? row.created_at, sessionId: row.session_id, name: row.session_name, summary: row.summary });
    }
  }
  for (const f of profile?.prior_crisis_flags ?? []) {
    events.push({ kind: 'crisis', date: f.flagged_at, sessionId: f.session_id, severity: f.severity, resolvedAt: f.unflagged_at, resolvedBy: f.unflagged_by });
  }
  if (profile?.clinician_note) {
    events.push({ kind: 'note', date: profile.clinician_note.created_at, author: profile.clinician_note.author, notes: profile.clinician_note.notes });
  }
  if (profile?.safety_plan) {
    events.push({ kind: 'safety', date: profile.safety_plan.created_at, sessionId: profile.safety_plan.session_id });
  }
  if (profile?.thought_record) {
    events.push({ kind: 'worksheet', date: profile.thought_record.created_at, record: profile.thought_record.record });
  }
  return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function SummaryBody({ summary }: { summary: SessionSummary }) {
  return (
    <div className="mt-1.5 space-y-1 text-sm text-gray-600">
      {summary.topics?.length ? <TagList items={summary.topics} tone="bg-indigo-100 text-indigo-800" /> : null}
      {summary.mood_trajectory && <p>Mood: {summary.mood_trajectory}</p>}
      {summary.techniques_helped?.length ? <p className="text-emerald-700">Helped: {summary.techniques_helped.join(', ')}</p> : null}
      {summary.follow_up && <p className="text-gray-500">Follow-up: {summary.follow_up}</p>}
    </div>
  );
}

function TimelineEntry({ event, onViewSession }: { event: TimelineEvent; onViewSession: (id: string) => void }) {
  const meta = {
    session: { icon: MessageCircle, tone: 'bg-gray-100 text-gray-500' },
    summary: { icon: MessageCircle, tone: 'bg-indigo-100 text-indigo-600' },
    crisis: { icon: AlertTriangle, tone: 'bg-red-100 text-red-600' },
    note: { icon: FileText, tone: 'bg-purple-100 text-purple-600' },
    safety: { icon: Heart, tone: 'bg-red-50 text-red-500' },
    worksheet: { icon: BookOpen, tone: 'bg-teal-100 text-teal-600' },
  }[event.kind];
  const Icon = meta.icon;

  return (
    <li className="flex gap-3">
      <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${meta.tone}`} aria-hidden="true">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1 pb-4 border-b border-gray-100">
        {event.kind === 'session' && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => onViewSession(event.session.session_id)} className="text-sm font-semibold text-royal hover:underline text-left">
                {event.summary?.headline || event.session.session_name || event.session.session_id.slice(0, 8)}
              </button>
              <span className="text-xs text-gray-400">{formatDate(event.date)}</span>
              {event.session.crisis_flagged && (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                  event.session.crisis_severity === 'high' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                }`}>crisis: {event.session.crisis_severity ?? 'flagged'}</span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {formatDuration(event.session.duration_seconds)} · {event.session.total_messages} messages
              {event.session.eval_score !== null && <> · eval {event.session.eval_score}</>}
              {event.session.feedback_rating !== null && <> · feedback {event.session.feedback_rating}/5</>}
              {event.session.status === 'active' && <> · <span className="text-emerald-700 font-medium">active</span></>}
            </p>
            {event.summary && <SummaryBody summary={event.summary} />}
          </>
        )}
        {event.kind === 'summary' && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => onViewSession(event.sessionId)} className="text-sm font-semibold text-royal hover:underline text-left">
                {event.summary.headline || event.name || 'Session'}
              </button>
              <span className="text-xs text-gray-400">{formatDate(event.date)}</span>
            </div>
            <SummaryBody summary={event.summary} />
          </>
        )}
        {event.kind === 'crisis' && (
          <>
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className="font-semibold text-red-700">Crisis flag</span>
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                event.severity === 'high' ? 'bg-red-100 text-red-800' : event.severity === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
              }`}>{event.severity ?? 'unknown'}</span>
              <span className="text-xs text-gray-400">{formatDate(event.date)}</span>
            </div>
            <p className="text-xs mt-0.5">
              {event.resolvedAt
                ? <span className="text-gray-500">Resolved {formatDate(event.resolvedAt)}{event.resolvedBy && <> by {event.resolvedBy}</>}</span>
                : <span className="text-red-600 font-medium">Unresolved</span>}
              {' · '}
              <button onClick={() => onViewSession(event.sessionId)} className="text-royal hover:underline">view session</button>
            </p>
          </>
        )}
        {event.kind === 'note' && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-purple-700">Clinician note</span>
              <span className="text-xs text-gray-400">{event.author ?? 'unknown'} · {formatDate(event.date)}</span>
            </div>
            <blockquote className="text-sm text-gray-700 border-l-2 border-purple-300 pl-3 italic mt-1">{event.notes}</blockquote>
            <p className="text-xs text-gray-400 mt-1">Injected into their next session · never shown to the participant.</p>
          </>
        )}
        {event.kind === 'safety' && (
          <div className="text-sm">
            <span className="font-semibold text-gray-800">Safety plan created</span>
            <span className="text-xs text-gray-400 ml-2">{formatDate(event.date)}</span>
            <p className="text-xs text-gray-500 mt-0.5">
              Full plan in the drawer below
              {event.sessionId && <> · <button onClick={() => onViewSession(event.sessionId!)} className="text-royal hover:underline">view session</button></>}
            </p>
          </div>
        )}
        {event.kind === 'worksheet' && (
          <details className="text-sm">
            <summary className="cursor-pointer select-none">
              <span className="font-semibold text-gray-800">Thought record completed</span>
              <span className="text-xs text-gray-400 ml-2">{formatDate(event.date)}</span>
            </summary>
            <div className="mt-1 space-y-0.5 text-gray-600">
              {Object.entries(event.record).map(([k, v]) => v ? (
                <p key={k}><span className="font-medium capitalize">{k.replace(/_/g, ' ')}:</span> {v}</p>
              ) : null)}
            </div>
          </details>
        )}
      </div>
    </li>
  );
}

// ---------- main component ----------

export default function ParticipantProfile({ user, userRole, onClose, onViewSession, onNavigate }: ParticipantProfileProps) {
  const profileFetch = useAdminFetch<ProfileBundle>(`/admin/api/users/${user.userid}/profile`);
  const sessionsFetch = useAdminFetch<{ sessions: UserSessionRow[] }>(`/admin/api/users/${user.userid}/sessions?limit=50`);
  // Fail-soft brief: any error (403, LLM down) simply hides the paragraph.
  const briefFetch = useAdminFetch<{ brief: string | null }>(`/admin/api/users/${user.userid}/brief`);

  const profile = profileFetch.data;
  const profileDenied = profileFetch.error?.includes('(403)') ?? false;
  const sessions = sessionsFetch.data?.sessions ?? null;
  const sessionsDenied = sessionsFetch.error?.includes('(403)') ?? false;
  const brief = briefFetch.error ? null : briefFetch.data?.brief ?? null;

  const [riskBusy, setRiskBusy] = useState(false);
  // Local mirror so the toggle works even when the full profile is 403 for researchers.
  const [riskShareEnabled, setRiskShareEnabled] = useState(!!user.risk_context_share_enabled);
  useEffect(() => {
    if (profile) setRiskShareEnabled(profile.risk_context_share_enabled);
  }, [profile]);

  // Escape closes the profile (matching SessionDetail behavior).
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const toggleRiskContext = async () => {
    setRiskBusy(true);
    try {
      const res = await fetch(`/admin/api/users/${user.userid}/risk-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: !riskShareEnabled }),
      });
      if (res.ok) {
        setRiskShareEnabled(!riskShareEnabled);
        // Prior-flag visibility follows the toggle — refresh the bundle.
        if (!profileDenied) profileFetch.refetch();
      }
    } finally {
      setRiskBusy(false);
    }
  };

  const memoryEnabled = profile?.memory_enabled ?? user.memory_enabled ?? false;
  const caseProfile = profile?.case_profile?.profile ?? null;

  // Status-strip series, oldest first.
  const scaleSeries = (scale: string) => (profile?.scale_history ?? [])
    .filter(p => p.scale === scale)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map(p => p.score);
  const moodSeries = useMemo(() => [...(profile?.mood_trajectory ?? [])]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map(p => p.mood), [profile]);

  const lastSession = sessions?.find(s => s.start_time) ?? null;
  const unresolvedFlags = (profile?.prior_crisis_flags ?? []).filter(f => !f.unflagged_at);

  const timeline = useMemo(() => buildTimeline(profile ?? null, sessions), [profile, sessions]);
  const loading = profileFetch.loading || sessionsFetch.loading;

  return (
    <div className="fixed inset-0 z-40 bg-gray-100 overflow-y-auto" role="dialog" aria-modal="true" aria-label={`Participant profile for ${user.username}`}>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-10 h-10 rounded-full bg-royal text-white flex items-center justify-center shrink-0">
              <User size={20} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-900 truncate">{user.username}</h2>
              <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                <span className="capitalize">{user.role}</span>
                <span className="inline-flex items-center gap-1"><Calendar size={11} /> joined {formatDate(user.created_at)}</span>
                <span className={`inline-flex items-center gap-1 ${memoryEnabled ? 'text-emerald-700' : 'text-gray-400'}`}>
                  <Cpu size={11} /> memory {memoryEnabled ? 'on' : 'off'}
                </span>
                <span className={`inline-flex items-center gap-1 ${riskShareEnabled ? 'text-emerald-700' : 'text-gray-400'}`}>
                  <Shield size={11} /> risk context {riskShareEnabled ? 'shared' : 'private'}
                </span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-gray-800 min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
            aria-label="Close participant profile"
          >
            <X size={22} />
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {loading && (
          <div className="text-center py-10 text-gray-500" role="status" aria-live="polite">Loading profile…</div>
        )}

        {profileFetch.error && !profileDenied && !profileFetch.loading && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">Failed to load the clinical profile.</div>
        )}

        {profileDenied && !profileFetch.loading && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
            <Lock size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              <p className="font-semibold">Clinical sections require the therapist role.</p>
              <p className="mt-1">
                The status strip, AI brief, and clinical timeline entries are derived from unredacted clinical
                content and are only visible to therapists (the same rule as session insights). Your{' '}
                {userRole ?? 'current'} account can still browse this participant&rsquo;s session history and
                manage the risk-context toggle.
              </p>
            </div>
          </div>
        )}

        {/* ============ 1. Status strip — the 5-second read ============ */}
        {!loading && profile && (
          <section aria-label="Status at a glance" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <TrendTile label="PHQ-2" values={scaleSeries('phq2')} max={6} higherIsBetter={false} empty="No screeners yet" />
            <TrendTile label="GAD-2" values={scaleSeries('gad2')} max={6} higherIsBetter={false} empty="No screeners yet" />
            <TrendTile label="Mood" values={moodSeries} max={10} higherIsBetter={true} unit="/10" empty="No mood data yet" />
            <StatCard
              label="Sessions"
              value={profile.ended_session_count}
              sub={lastSession ? `Last ${relativeDate(lastSession.start_time)}` : 'No sessions yet'}
              icon={MessageCircle}
            />
            <Panel className={`!p-4 ${unresolvedFlags.length > 0 ? '!bg-red-50 border border-red-200' : ''}`}>
              <p className="text-xs text-gray-500">Risk</p>
              {unresolvedFlags.length > 0 ? (
                <p className="text-sm font-semibold text-red-700 mt-2 inline-flex items-center gap-1.5">
                  <AlertTriangle size={14} /> {unresolvedFlags.length} unresolved flag{unresolvedFlags.length === 1 ? '' : 's'}
                </p>
              ) : (
                <p className="text-sm text-gray-600 mt-2 inline-flex items-center gap-1.5">
                  <Shield size={14} className="text-gray-400" /> No active flags
                </p>
              )}
              {!riskShareEnabled && <p className="text-xs text-gray-400 mt-1">Risk sharing off</p>}
            </Panel>
          </section>
        )}

        {/* ============ 2. AI brief ============ */}
        {!loading && profile && brief && (
          <section aria-label="AI brief" className="px-1">
            <p className="text-sm text-gray-600 italic leading-relaxed">{brief}</p>
            <p className="text-xs text-gray-400 mt-1">AI-generated summary — verify against the record.</p>
          </section>
        )}

        {/* ============ 3. Unified timeline ============ */}
        {!loading && (
          <section aria-label="Timeline">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
              <Activity size={15} className="text-gray-500" /> Timeline
            </h3>
            <Panel>
              {sessionsDenied && !profile ? (
                <p className="text-sm text-gray-500">Your role does not have access to this participant&rsquo;s session list.</p>
              ) : timeline.length === 0 ? (
                <p className="text-sm text-gray-400">Nothing yet — this participant has not started a conversation.</p>
              ) : (
                <ol className="space-y-4">
                  {timeline.map((event, i) => (
                    <TimelineEntry key={`${event.kind}-${event.date}-${i}`} event={event} onViewSession={onViewSession} />
                  ))}
                </ol>
              )}
            </Panel>
          </section>
        )}

        {/* ============ 3b. Care notes + escalations + messaging (caseworker portal) ============ */}
        {(userRole === 'therapist' || userRole === 'caseworker') && (
          <section aria-label="Care notes">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
              <FileText size={15} className="text-gray-500" /> Care notes
            </h3>
            <NotesPanel clientId={user.userid} userRole={userRole} />
          </section>
        )}

        {(userRole === 'therapist' || userRole === 'caseworker' || userRole === 'researcher') && (
          <section aria-label="Escalations">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
              <AlertTriangle size={15} className="text-gray-500" /> Escalations
            </h3>
            <MyEscalations
              clientId={user.userid}
              mineOnly={false}
              onOpenEscalations={onNavigate ? () => onNavigate('escalations') : undefined}
            />
          </section>
        )}

        {(userRole === 'therapist' || userRole === 'caseworker') && (
          <section aria-label="Messages">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
              <MessageCircle size={15} className="text-gray-500" /> Messages
            </h3>
            {/* Resolves/creates only the viewing clinician's own thread with
                this client (one thread per client-clinician pair). */}
            <MessageThreadView clientId={user.userid} clientName={user.username} />
          </section>
        )}

        {/* ============ 4. Details drawer — memory and clinical model ============ */}
        {!loading && (profile || profileDenied) && (
          <section aria-label="Memory and clinical model">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
              <List size={15} className="text-gray-500" /> Memory and clinical model
            </h3>
            <Panel>
              {profile && !profile.memory_enabled && (
                <p className="text-sm text-gray-500 mb-2">
                  This participant has not opted into cross-session memory — nothing below is injected into their
                  sessions. Data shown was stored before memory was turned off, or by tools during individual sessions.
                </p>
              )}

              {profile && (
                <DrawerSection title="Clinical case profile" defaultOpen>
                  {caseProfile ? (
                    <div className="space-y-3">
                      {([
                        ['Presenting concerns', caseProfile.presenting_concerns, 'bg-indigo-100 text-indigo-800'],
                        ['Recurring themes', caseProfile.recurring_themes, 'bg-gray-100 text-gray-700'],
                        ['Stressors', caseProfile.stressors, 'bg-amber-100 text-amber-800'],
                        ['Support system', caseProfile.support_system, 'bg-emerald-100 text-emerald-800'],
                        ['Values', caseProfile.values, 'bg-sky-100 text-sky-800'],
                      ] as const).map(([label, items, tone]) => items?.length ? (
                        <div key={label}>
                          <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
                          <TagList items={items} tone={tone} />
                        </div>
                      ) : null)}
                      {caseProfile.coping_repertoire?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Coping repertoire (most helpful first)</p>
                          <ul className="space-y-1">
                            {caseProfile.coping_repertoire.map(c => (
                              <li key={c.technique} className="flex items-center justify-between gap-2">
                                <span>{c.technique}</span>
                                <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">{c.helpfulness.replace(/_/g, ' ')}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {caseProfile.screener_trend && (
                        <p className="text-xs text-gray-500">Screener trend: <span className="text-gray-700">{caseProfile.screener_trend}</span></p>
                      )}
                      {profile.case_profile && (
                        <p className="text-xs text-gray-400">Rolled up from all prior sessions · updated {formatDate(profile.case_profile.updated_at)}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-gray-400">No case profile yet. One is built automatically after their first few completed sessions.</p>
                  )}
                </DrawerSection>
              )}

              {profile && (
                <DrawerSection title={`Remembered facts (${profile.memories.length})`}>
                  {profile.memories.length > 0 ? (
                    <ul className="space-y-2 max-h-72 overflow-y-auto pr-1">
                      {profile.memories.map((m, i) => (
                        <li key={i} className="flex items-start justify-between gap-3 bg-indigo-50/60 rounded px-3 py-2">
                          <span>{m.fact}</span>
                          <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(m.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-gray-400">Nothing stored. Facts appear here when the participant asks the AI to remember something (the remember_this tool).</p>
                  )}
                </DrawerSection>
              )}

              <DrawerSection title="Sharing controls" defaultOpen={profileDenied}>
                <div className="flex items-center justify-between gap-3 bg-gray-50 rounded px-3 py-2">
                  <p className="text-xs text-gray-600">Share prior crisis history with the AI at session start</p>
                  <button
                    type="button"
                    onClick={toggleRiskContext}
                    disabled={riskBusy}
                    aria-pressed={riskShareEnabled}
                    className={`px-2.5 py-1 inline-flex items-center gap-1 text-xs font-semibold rounded-full transition disabled:opacity-50 ${
                      riskShareEnabled ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${riskShareEnabled ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                    {riskShareEnabled ? 'On' : 'Off'}
                  </button>
                </div>
                {!riskShareEnabled && (
                  <p className="text-xs text-gray-400 mt-2">
                    Sharing is off, so prior-crisis history is not compiled here or for the AI. Enable it only after clinical review.
                  </p>
                )}
              </DrawerSection>

              {profile?.thought_record && (
                <DrawerSection title="Latest thought record">
                  <div className="space-y-1">
                    {Object.entries(profile.thought_record.record).map(([k, v]) => v ? (
                      <p key={k}><span className="font-medium capitalize">{k.replace(/_/g, ' ')}:</span> {v}</p>
                    ) : null)}
                    <p className="text-xs text-gray-400 pt-1">Completed {formatDate(profile.thought_record.created_at)}</p>
                  </div>
                </DrawerSection>
              )}

              {profile?.safety_plan && (
                <DrawerSection title="Safety plan">
                  <div className="space-y-2">
                    {Object.entries(profile.safety_plan.plan).map(([section, items]) =>
                      Array.isArray(items) && items.length > 0 ? (
                        <div key={section}>
                          <span className="font-medium capitalize">{section.replace(/_/g, ' ')}:</span> {items.join('; ')}
                        </div>
                      ) : null
                    )}
                    <p className="text-xs text-gray-400 pt-1">
                      Created {formatDate(profile.safety_plan.created_at)}
                      {profile.safety_plan.session_id && (
                        <> in <button onClick={() => onViewSession(profile.safety_plan!.session_id!)} className="text-royal hover:underline">this session</button></>
                      )}
                    </p>
                  </div>
                </DrawerSection>
              )}
            </Panel>
          </section>
        )}
      </div>
    </div>
  );
}
