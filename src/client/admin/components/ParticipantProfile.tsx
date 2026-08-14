// Participant profile drill-down (ai-therapist-110): a memory-first clinical
// view of one participant — what the AI remembers about them (the exact bundle
// promptContext injects at session start), risk/safety context, screener and
// mood trends, and their session history. Opened from the Users table; session
// rows open the existing SessionDetail on top.
import { useState, useEffect, useCallback } from 'react';
import {
  X, User, Cpu, Shield, AlertTriangle, TrendingUp, List, MessageCircle,
  Calendar, Mic, Globe, Lock, BookOpen, Heart, FileText, Eye,
} from 'react-feather';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

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
}

const SCALE_COLORS: Record<string, string> = { phq2: '#4f46e5', gad2: '#0d9488' };

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString() : '—';
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
  const s = Math.round(Number(seconds));
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Badge({ on, labelOn, labelOff, icon: Icon }: { on: boolean; labelOn: string; labelOff: string; icon: React.ComponentType<{ size?: number | string }> }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
      on ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'
    }`}>
      <Icon size={12} />
      {on ? labelOn : labelOff}
    </span>
  );
}

function SectionCard({ title, icon: Icon, children, accent = 'text-gray-500' }: {
  title: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2 mb-3">
        <Icon size={16} className={accent} />
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400">{children}</p>;
}

function TagList({ items, tone = 'bg-gray-100 text-gray-700' }: { items: string[]; tone?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => (
        <span key={item} className={`px-2 py-0.5 rounded text-xs ${tone}`}>{item}</span>
      ))}
    </div>
  );
}

export default function ParticipantProfile({ user, userRole, onClose, onViewSession }: ParticipantProfileProps) {
  const [profile, setProfile] = useState<ProfileBundle | null>(null);
  const [profileDenied, setProfileDenied] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [sessions, setSessions] = useState<UserSessionRow[] | null>(null);
  const [sessionsDenied, setSessionsDenied] = useState(false);
  const [riskBusy, setRiskBusy] = useState(false);
  // Local mirror so the toggle works even when the full profile is 403 for researchers.
  const [riskShareEnabled, setRiskShareEnabled] = useState(!!user.risk_context_share_enabled);

  const fetchProfile = useCallback(async () => {
    setLoadingProfile(true);
    setProfileError(null);
    setProfileDenied(false);
    try {
      const res = await fetch(`/admin/api/users/${user.userid}/profile`, { credentials: 'include' });
      if (res.status === 403) {
        setProfileDenied(true);
      } else if (res.ok) {
        const data = await res.json() as ProfileBundle;
        setProfile(data);
        setRiskShareEnabled(data.risk_context_share_enabled);
      } else {
        setProfileError('Failed to load the clinical profile.');
      }
    } catch {
      setProfileError('Failed to load the clinical profile.');
    } finally {
      setLoadingProfile(false);
    }
  }, [user.userid]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`/admin/api/users/${user.userid}/sessions?limit=50`, { credentials: 'include' });
      if (res.status === 403) {
        setSessionsDenied(true);
      } else if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions as UserSessionRow[]);
      } else {
        setSessions([]);
      }
    } catch {
      setSessions([]);
    }
  }, [user.userid]);

  useEffect(() => { void fetchProfile(); }, [fetchProfile]);
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

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
        if (!profileDenied) void fetchProfile();
      }
    } finally {
      setRiskBusy(false);
    }
  };

  const memoryEnabled = profile?.memory_enabled ?? user.memory_enabled ?? false;
  const caseProfile = profile?.case_profile?.profile ?? null;

  // Screener chart: one point per response, a line per scale, oldest first.
  const scaleChartData = (() => {
    if (!profile || profile.scale_history.length === 0) return [];
    const byDate = new Map<string, Record<string, number | string>>();
    const sorted = [...profile.scale_history].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const point of sorted) {
      const key = new Date(point.created_at).toISOString();
      const row = byDate.get(key) ?? { date: new Date(point.created_at).toLocaleDateString() };
      row[point.scale] = point.score;
      byDate.set(key, row);
    }
    return Array.from(byDate.values());
  })();
  const scalesPresent = profile ? Array.from(new Set(profile.scale_history.map(p => p.scale))) : [];

  const moodChartData = profile
    ? [...profile.mood_trajectory]
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .map(p => ({ date: new Date(p.date).toLocaleDateString(), mood: p.mood, source: p.source }))
    : [];

  const accountFacts = [
    { icon: Calendar, label: 'Joined', value: formatDate(user.created_at) },
    { icon: Mic, label: 'Voice', value: user.preferred_voice || 'cedar' },
    { icon: Globe, label: 'Language', value: user.preferred_language || 'en' },
    { icon: Lock, label: 'MFA', value: user.mfa_enabled ? 'Enabled' : 'Off' },
  ];

  return (
    <div className="fixed inset-0 z-40 bg-gray-100 overflow-y-auto" role="dialog" aria-modal="true" aria-label={`Participant profile for ${user.username}`}>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="w-10 h-10 rounded-full bg-royal text-white flex items-center justify-center shrink-0">
                <User size={20} />
              </span>
              <div>
                <h2 className="text-xl font-bold text-gray-900 truncate">{user.username}</h2>
                <p className="text-xs text-gray-500">
                  <span className="capitalize">{user.role}</span>
                  {profile !== null && <> · {profile.ended_session_count} completed session{profile.ended_session_count === 1 ? '' : 's'}</>}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap ml-1">
                <Badge on={memoryEnabled} labelOn="Memory on" labelOff="Memory off" icon={Cpu} />
                <Badge on={riskShareEnabled} labelOn="Risk context shared" labelOff="Risk context private" icon={Shield} />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-4 flex-wrap text-xs text-gray-500">
              {accountFacts.map(f => {
                const Icon = f.icon;
                return (
                  <span key={f.label} className="inline-flex items-center gap-1">
                    <Icon size={12} className="text-gray-400" />
                    {f.label}: <span className="text-gray-700 font-medium capitalize">{f.value}</span>
                  </span>
                );
              })}
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

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {loadingProfile && (
          <div className="text-center py-10 text-gray-500" role="status" aria-live="polite">Loading profile…</div>
        )}

        {profileError && !loadingProfile && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{profileError}</div>
        )}

        {profileDenied && !loadingProfile && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
            <Lock size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              <p className="font-semibold">Clinical sections require the therapist role.</p>
              <p className="mt-1">
                The memory, risk, and screener sections below are derived from unredacted clinical content and are
                only visible to therapists (the same rule as session insights). Your {userRole ?? 'current'} account
                can still browse this participant&rsquo;s session history and manage the risk-context toggle.
              </p>
            </div>
          </div>
        )}

        {/* ============ Memory and clinical model ============ */}
        {!loadingProfile && !profileDenied && profile && (
          <>
            <section aria-label="Memory and clinical model">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Cpu size={18} className="text-indigo-600" />
                  Memory and clinical model
                </h2>
                <span className="text-xs text-gray-400">What the AI remembers about this participant at session start</span>
              </div>

              {!profile.memory_enabled && (
                <div className="bg-white rounded-lg shadow p-4 mb-4 text-sm text-gray-600">
                  This participant has not opted into cross-session memory, so the AI starts every conversation
                  fresh — nothing below is injected into their sessions. Any data shown here was stored before
                  memory was turned off, or by tools during individual sessions.
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Case profile */}
                <SectionCard title="Clinical case profile" icon={FileText} accent="text-indigo-600">
                  {caseProfile ? (
                    <div className="space-y-3 text-sm text-gray-700">
                      {caseProfile.presenting_concerns?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Presenting concerns</p>
                          <TagList items={caseProfile.presenting_concerns} tone="bg-indigo-100 text-indigo-800" />
                        </div>
                      ) : null}
                      {caseProfile.recurring_themes?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Recurring themes</p>
                          <TagList items={caseProfile.recurring_themes} />
                        </div>
                      ) : null}
                      {caseProfile.stressors?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Stressors</p>
                          <TagList items={caseProfile.stressors} tone="bg-amber-100 text-amber-800" />
                        </div>
                      ) : null}
                      {caseProfile.support_system?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Support system</p>
                          <TagList items={caseProfile.support_system} tone="bg-emerald-100 text-emerald-800" />
                        </div>
                      ) : null}
                      {caseProfile.coping_repertoire?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Coping repertoire (most helpful first)</p>
                          <ul className="space-y-1">
                            {caseProfile.coping_repertoire.map(c => (
                              <li key={c.technique} className="flex items-center justify-between gap-2">
                                <span>{c.technique}</span>
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  c.helpfulness === 'helped' ? 'bg-emerald-100 text-emerald-800'
                                    : c.helpfulness === 'mixed' ? 'bg-amber-100 text-amber-800'
                                    : 'bg-gray-100 text-gray-600'
                                }`}>{c.helpfulness.replace(/_/g, ' ')}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {caseProfile.values?.length ? (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">Values</p>
                          <TagList items={caseProfile.values} tone="bg-sky-100 text-sky-800" />
                        </div>
                      ) : null}
                      {caseProfile.screener_trend && (
                        <p className="text-xs text-gray-500">Screener trend: <span className="text-gray-700">{caseProfile.screener_trend}</span></p>
                      )}
                      {profile.case_profile && (
                        <p className="text-xs text-gray-400 pt-1 border-t border-gray-100">
                          Rolled up from all prior sessions · updated {formatDate(profile.case_profile.updated_at)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <EmptyNote>No case profile yet. One is built automatically after their first few completed sessions.</EmptyNote>
                  )}
                </SectionCard>

                {/* Remembered facts */}
                <SectionCard title="Remembered facts" icon={BookOpen} accent="text-indigo-600">
                  {profile.memories.length > 0 ? (
                    <ul className="space-y-2 text-sm text-gray-700 max-h-72 overflow-y-auto pr-1">
                      {profile.memories.map((m, i) => (
                        <li key={i} className="flex items-start justify-between gap-3 bg-indigo-50/60 rounded px-3 py-2">
                          <span>{m.fact}</span>
                          <span className="text-xs text-gray-400 whitespace-nowrap">{formatDate(m.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyNote>
                      Nothing stored. Facts appear here when the participant asks the AI to remember something
                      (the remember_this tool).
                    </EmptyNote>
                  )}
                </SectionCard>
              </div>

              {/* Session summaries timeline */}
              <div className="mt-4">
                <SectionCard title="Session summaries" icon={MessageCircle} accent="text-indigo-600">
                  {profile.summaries.length > 0 ? (
                    <ol className="relative border-l border-indigo-200 ml-2 space-y-4">
                      {profile.summaries.map(row => {
                        const s = row.summary;
                        return (
                          <li key={row.session_id} className="ml-4">
                            <span className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-indigo-400" aria-hidden="true" />
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => onViewSession(row.session_id)}
                                className="text-sm font-semibold text-royal hover:underline text-left"
                              >
                                {s.headline || row.session_name || 'Session'}
                              </button>
                              <span className="text-xs text-gray-400">{formatDate(row.ended_at ?? row.created_at)}</span>
                            </div>
                            <div className="mt-1 text-sm text-gray-600 space-y-1">
                              {s.topics?.length ? <TagList items={s.topics} tone="bg-indigo-100 text-indigo-800" /> : null}
                              {s.mood_trajectory && <p>{s.mood_trajectory}</p>}
                              {s.techniques_helped?.length ? <p className="text-emerald-700">Helped: {s.techniques_helped.join(', ')}</p> : null}
                              {s.follow_up && <p className="text-gray-500">Follow-up: {s.follow_up}</p>}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <EmptyNote>
                      No end-of-session summaries yet. A summary is generated when this participant finishes a session
                      with memory enabled.
                    </EmptyNote>
                  )}
                </SectionCard>
              </div>

              {profile.clinician_note && (
                <div className="mt-4">
                  <SectionCard title="Latest clinician note (injected into their next session)" icon={FileText} accent="text-purple-600">
                    <blockquote className="text-sm text-gray-700 border-l-2 border-purple-300 pl-3 italic">
                      {profile.clinician_note.notes}
                    </blockquote>
                    <p className="text-xs text-gray-400 mt-2">
                      Left by {profile.clinician_note.author ?? 'unknown'} on {formatDate(profile.clinician_note.created_at)} — private, never shown to the participant.
                    </p>
                  </SectionCard>
                </div>
              )}
            </section>

            {/* ============ Risk and safety ============ */}
            <section aria-label="Risk and safety">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-3">
                <AlertTriangle size={18} className="text-red-600" />
                Risk and safety
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SectionCard title="Prior crisis flags" icon={AlertTriangle} accent="text-red-600">
                  <div className="mb-3 flex items-center justify-between gap-3 bg-gray-50 rounded px-3 py-2">
                    <p className="text-xs text-gray-600">
                      Share prior crisis history with the AI at session start
                    </p>
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
                  {riskShareEnabled ? (
                    profile.prior_crisis_flags.length > 0 ? (
                      <ul className="space-y-2 text-sm">
                        {profile.prior_crisis_flags.map(f => (
                          <li key={`${f.session_id}-${f.flagged_at}`} className="flex items-center justify-between gap-2">
                            <button onClick={() => onViewSession(f.session_id)} className="text-royal hover:underline text-left">
                              {formatDate(f.flagged_at)}
                            </button>
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                              f.severity === 'high' ? 'bg-red-100 text-red-800'
                                : f.severity === 'medium' ? 'bg-amber-100 text-amber-800'
                                : 'bg-gray-100 text-gray-600'
                            }`}>{f.severity ?? 'unknown'}</span>
                            <span className="text-xs text-gray-400">
                              {f.unflagged_at ? `resolved ${formatDate(f.unflagged_at)}` : 'unresolved'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <EmptyNote>No prior crisis flags on record.</EmptyNote>
                    )
                  ) : (
                    <EmptyNote>
                      Sharing is off, so prior-crisis history is not compiled here or for the AI. Enable it only
                      after clinical review.
                    </EmptyNote>
                  )}
                </SectionCard>

                <SectionCard title="Latest safety plan" icon={Heart} accent="text-red-600">
                  {profile.safety_plan ? (
                    <div className="space-y-2 text-sm text-gray-700">
                      {Object.entries(profile.safety_plan.plan).map(([section, items]) =>
                        Array.isArray(items) && items.length > 0 ? (
                          <div key={section}>
                            <span className="font-medium capitalize">{section.replace(/_/g, ' ')}:</span>{' '}
                            {items.join('; ')}
                          </div>
                        ) : null
                      )}
                      <p className="text-xs text-gray-400 pt-1 border-t border-gray-100">
                        Created {formatDate(profile.safety_plan.created_at)}
                        {profile.safety_plan.session_id && (
                          <>
                            {' '}in{' '}
                            <button onClick={() => onViewSession(profile.safety_plan!.session_id!)} className="text-royal hover:underline">
                              this session
                            </button>
                          </>
                        )}
                      </p>
                    </div>
                  ) : (
                    <EmptyNote>No safety plan on file. One is saved when the participant builds one with the AI.</EmptyNote>
                  )}
                </SectionCard>
              </div>
            </section>

            {/* ============ Screeners and mood ============ */}
            <section aria-label="Screeners and mood">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-3">
                <TrendingUp size={18} className="text-teal-600" />
                Screeners and mood
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SectionCard title="PHQ-2 / GAD-2 trend" icon={TrendingUp} accent="text-teal-600">
                  {scaleChartData.length > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={scaleChartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="date" fontSize={11} />
                          <YAxis domain={[0, 6]} allowDecimals={false} fontSize={11} />
                          <Tooltip />
                          <ReferenceLine y={3} stroke="#f59e0b" strokeDasharray="4 4" />
                          {scalesPresent.map(scale => (
                            <Line
                              key={scale}
                              type="monotone"
                              dataKey={scale}
                              stroke={SCALE_COLORS[scale] ?? '#6b7280'}
                              name={scale.toUpperCase()}
                              connectNulls
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                      <p className="text-xs text-gray-400 mt-1">Dashed line marks the clinical cutoff (3). Screeners, not diagnoses.</p>
                    </>
                  ) : (
                    <EmptyNote>No screener responses yet. Scores appear after the AI administers a PHQ-2 or GAD-2 in session.</EmptyNote>
                  )}
                </SectionCard>

                <SectionCard title="Mood trajectory" icon={Heart} accent="text-teal-600">
                  {moodChartData.length > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={moodChartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="date" fontSize={11} />
                          <YAxis domain={[0, 10]} allowDecimals={false} fontSize={11} />
                          <Tooltip />
                          <Line type="monotone" dataKey="mood" stroke="#0d9488" name="Mood (1-10)" />
                        </LineChart>
                      </ResponsiveContainer>
                      <p className="text-xs text-gray-400 mt-1">From pre-session check-ins and in-session mood logs.</p>
                    </>
                  ) : (
                    <EmptyNote>No mood data yet. Points come from pre-session check-ins and in-session mood ratings.</EmptyNote>
                  )}
                </SectionCard>
              </div>

              {profile.thought_record && (
                <div className="mt-4">
                  <SectionCard title="Latest thought record" icon={FileText} accent="text-teal-600">
                    <div className="space-y-1 text-sm text-gray-700">
                      {(['situation', 'thought', 'feeling', 'evidence_for', 'evidence_against', 'balanced_thought'] as const).map(k =>
                        profile.thought_record!.record[k] ? (
                          <div key={k}>
                            <span className="font-medium capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
                            {profile.thought_record!.record[k]}
                          </div>
                        ) : null
                      )}
                      <p className="text-xs text-gray-400 pt-1">Completed {formatDate(profile.thought_record.created_at)}</p>
                    </div>
                  </SectionCard>
                </div>
              )}
            </section>
          </>
        )}

        {/* ============ Session history ============ */}
        <section aria-label="Session history">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-3">
            <List size={18} className="text-gray-600" />
            Session history
          </h2>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {sessionsDenied ? (
              <p className="p-4 text-sm text-gray-500">Your role does not have access to this participant&rsquo;s session list.</p>
            ) : sessions === null ? (
              <p className="p-4 text-sm text-gray-500" role="status">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">No sessions yet — this participant has not started a conversation.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {['Session', 'Started', 'Duration', 'Messages', 'Ended by', 'Crisis', 'Eval', 'Feedback', ''].map(h => (
                        <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {sessions.map(s => (
                      <tr key={s.session_id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 max-w-[220px]">
                          <button onClick={() => onViewSession(s.session_id)} className="text-royal hover:underline font-medium text-left truncate block max-w-full">
                            {s.session_name || s.session_id.slice(0, 8)}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{new Date(s.start_time).toLocaleString()}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{formatDuration(s.duration_seconds)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{s.total_messages}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">
                          {s.status === 'active' ? <span className="text-emerald-700 font-medium">active</span> : (s.ended_by || '—')}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {s.crisis_flagged ? (
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                              s.crisis_severity === 'high' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                            }`}>{s.crisis_severity ?? 'flagged'}</span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{s.eval_score !== null ? s.eval_score : '—'}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">{s.feedback_rating !== null ? `${s.feedback_rating}/5` : '—'}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right">
                          <button
                            onClick={() => onViewSession(s.session_id)}
                            className="text-royal hover:text-blue-700 inline-flex items-center gap-1"
                            aria-label={`View session ${s.session_name || s.session_id}`}
                          >
                            <Eye size={14} /> View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
