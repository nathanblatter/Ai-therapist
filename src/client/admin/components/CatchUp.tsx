// Catch-up view (ai-therapist-229): the quick "how is this person doing"
// read a caseworker gets when they click into a client. Built entirely from
// the summaries-tier caseworker endpoints (roster detail + catchup) — AI
// session summaries, screener/risk/mood signals and an LLM rollup paragraph,
// never transcripts. Rendered inside ParticipantProfile for viewers without
// the therapist-only clinical bundle (caseworkers, researchers).
import { useMemo } from 'react';
import {
  AlertTriangle, ArrowUpRight, Clock, Heart, MessageCircle, Minus, Shield,
  TrendingDown, TrendingUp,
} from 'react-feather';
import Panel from './ui/Panel';
import StatCard from './ui/StatCard';
import useAdminFetch from '../hooks/useAdminFetch';
import { formatDate, timeAgo } from '../../shared/format';
import { severityBadgeClass } from '../../shared/severity';
// Type-only imports from the server tree (erased at build time).
import type { ClientEngagementSignals } from '../../../server/db/caseworkerDashboard.queries';
import type { SessionSummary } from '../../../server/db/insights.queries';

interface CatchUpDetail {
  client_id: number;
  recent_summaries: { session_id: string; ended_at: string | null; summary: SessionSummary | null }[];
  scale_history: { scale: string; score: number; created_at: string }[];
  risk_history: { risk_score: number; severity: string | null; calculated_at: string }[];
  mood_history: { mood: number | null; created_at: string }[];
  safety_plan: unknown;
}

interface CatchUpResponse {
  client_id: number;
  engagement: ClientEngagementSignals;
  summary: string | null;
  generated_at: string;
}

interface CatchUpProps {
  userId: number;
  onViewSession: (sessionId: string) => void;
}

const INACTIVITY_DAYS = 14;

const SEVERITY_RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, medium: 2, high: 3 };

/** Direction of the latest risk severity vs the previous reading. */
function riskTrend(history: CatchUpDetail['risk_history']): 'rising' | 'falling' | 'flat' | null {
  const [latest, prev] = history;
  if (!latest || !prev) return null;
  const a = SEVERITY_RANK[latest.severity ?? ''] ?? null;
  const b = SEVERITY_RANK[prev.severity ?? ''] ?? null;
  if (a === null || b === null || a === b) return a !== null && a === b ? 'flat' : null;
  return a > b ? 'rising' : 'falling';
}

const TREND_META = {
  rising: { icon: TrendingUp, tone: 'text-red-600', label: 'rising' },
  falling: { icon: TrendingDown, tone: 'text-emerald-600', label: 'easing' },
  flat: { icon: Minus, tone: 'text-gray-400', label: 'steady' },
} as const;

/** Latest score + delta vs previous per scale (input newest-first). */
function screenerSignals(history: CatchUpDetail['scale_history']) {
  const byScale = new Map<string, { score: number; created_at: string }[]>();
  for (const p of history) {
    const arr = byScale.get(p.scale) ?? [];
    arr.push(p);
    byScale.set(p.scale, arr);
  }
  return Array.from(byScale.entries()).map(([scale, points]) => {
    const [latest, prev] = points;
    return {
      scale,
      score: latest.score,
      at: latest.created_at,
      delta: prev ? latest.score - prev.score : null,
    };
  });
}

function FlagChip({ icon: Icon, label, tone }: { icon: typeof Shield; label: string; tone: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${tone}`}>
      <Icon size={12} aria-hidden="true" /> {label}
    </span>
  );
}

export default function CatchUp({ userId, onViewSession }: CatchUpProps) {
  const detailFetch = useAdminFetch<CatchUpDetail>(`/admin/api/caseworker/roster/${userId}/detail`);
  const catchupFetch = useAdminFetch<CatchUpResponse>(`/admin/api/caseworker/roster/${userId}/catchup`);

  const detail = detailFetch.data;
  const engagement = catchupFetch.data?.engagement ?? null;
  // Fail-soft AI paragraph: any error simply hides it (signals still render).
  const aiSummary = catchupFetch.error ? null : catchupFetch.data?.summary ?? null;

  const screeners = useMemo(() => screenerSignals(detail?.scale_history ?? []), [detail]);
  const latestRisk = detail?.risk_history[0] ?? null;
  const trend = detail ? riskTrend(detail.risk_history) : null;
  const latestMood = detail?.mood_history.find((m) => m.mood !== null) ?? null;

  const lastSessionAt = engagement?.last_session_at ?? null;
  const inactive =
    lastSessionAt !== null &&
    (engagement?.ended_session_count ?? 0) > 0 &&
    Date.now() - new Date(lastSessionAt).getTime() >= INACTIVITY_DAYS * 24 * 3600 * 1000;

  if (detailFetch.loading || catchupFetch.loading) {
    return <Panel><p className="text-sm text-gray-500 py-4 text-center">Loading catch-up…</p></Panel>;
  }
  if (detailFetch.error && catchupFetch.error) {
    return <Panel><p className="text-sm text-gray-500 py-4 text-center">Catch-up is not available for this client.</p></Panel>;
  }

  const TrendMeta = trend ? TREND_META[trend] : null;

  return (
    <div className="space-y-4">
      {/* Signal strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Last session"
          value={lastSessionAt ? timeAgo(lastSessionAt) : 'None yet'}
          sub={`${engagement?.ended_session_count ?? 0} completed`}
          icon={MessageCircle}
        />
        <Panel className="!p-4">
          <p className="text-xs text-gray-500">Risk</p>
          {latestRisk ? (
            <>
              <p className="mt-2">
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${severityBadgeClass(latestRisk.severity)}`}>
                  {latestRisk.severity ?? 'unknown'}
                </span>
              </p>
              <p className="text-xs mt-1 inline-flex items-center gap-1 text-gray-400">
                {TrendMeta && (
                  <span className={`inline-flex items-center gap-1 ${TrendMeta.tone}`}>
                    <TrendMeta.icon size={12} aria-hidden="true" /> {TrendMeta.label}
                  </span>
                )}
                <span>· {timeAgo(latestRisk.calculated_at)}</span>
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-400 mt-2">No risk scores yet</p>
          )}
        </Panel>
        <Panel className="!p-4">
          <p className="text-xs text-gray-500">Screeners</p>
          {screeners.length > 0 ? (
            <div className="mt-2 space-y-1">
              {screeners.map((s) => (
                <p key={s.scale} className="text-sm text-navy">
                  <span className="font-semibold uppercase">{s.scale}</span> {s.score}
                  {s.delta !== null && (
                    <span className={`text-xs ml-1 ${s.delta > 0 ? 'text-red-600' : s.delta < 0 ? 'text-emerald-600' : 'text-gray-400'}`}>
                      ({s.delta > 0 ? '+' : ''}{s.delta})
                    </span>
                  )}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 mt-2">No screeners yet</p>
          )}
        </Panel>
        <StatCard
          label="Check-in mood"
          value={latestMood ? `${latestMood.mood}/10` : '—'}
          sub={latestMood ? timeAgo(latestMood.created_at) : 'No check-ins yet'}
          icon={Heart}
        />
      </div>

      {/* Notable flags */}
      {engagement && (engagement.open_crisis_count > 0 || engagement.open_escalation_count > 0 || inactive || engagement.has_safety_plan) && (
        <div className="flex flex-wrap gap-2" aria-label="Notable flags">
          {engagement.open_crisis_count > 0 && (
            <FlagChip icon={AlertTriangle} tone="bg-red-100 text-red-700"
              label={`${engagement.open_crisis_count} open crisis flag${engagement.open_crisis_count === 1 ? '' : 's'}`} />
          )}
          {engagement.open_escalation_count > 0 && (
            <FlagChip icon={ArrowUpRight} tone="bg-yellow-100 text-yellow-800"
              label={`${engagement.open_escalation_count} open escalation${engagement.open_escalation_count === 1 ? '' : 's'}`} />
          )}
          {inactive && (
            <FlagChip icon={Clock} tone="bg-gray-100 text-gray-600" label={`No session in ${INACTIVITY_DAYS}+ days`} />
          )}
          {engagement.has_safety_plan && (
            <FlagChip icon={Shield} tone="bg-emerald-100 text-emerald-800" label="Safety plan on file" />
          )}
        </div>
      )}

      {/* AI catch-up paragraph */}
      {aiSummary && (
        <div className="px-1">
          <p className="text-sm text-gray-600 italic leading-relaxed">{aiSummary}</p>
          <p className="text-xs text-gray-400 mt-1">AI-generated from session summaries and signals — verify against the record.</p>
        </div>
      )}

      {/* Recent session summaries */}
      <Panel>
        {detail && detail.recent_summaries.length > 0 ? (
          <ol className="space-y-4">
            {detail.recent_summaries.map((row) => {
              const s = row.summary;
              return (
                <li key={row.session_id} className="pb-3 border-b border-gray-100 last:border-b-0 last:pb-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => onViewSession(row.session_id)}
                      className="text-sm font-semibold text-royal hover:underline text-left"
                    >
                      {s?.headline || 'Session'}
                    </button>
                    {row.ended_at && <span className="text-xs text-gray-400">{formatDate(row.ended_at)}</span>}
                  </div>
                  {s && (
                    <div className="mt-1.5 space-y-1 text-sm text-gray-600">
                      {s.topics?.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {s.topics.map((t) => (
                            <span key={t} className="px-2 py-0.5 rounded text-xs bg-indigo-100 text-indigo-800">{t}</span>
                          ))}
                        </div>
                      ) : null}
                      {s.mood_trajectory && <p>Mood: {s.mood_trajectory}</p>}
                      {s.follow_up && <p className="text-gray-500">Follow-up: {s.follow_up}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-gray-400">
            No session summaries yet — they appear automatically after each completed session.
          </p>
        )}
      </Panel>
    </div>
  );
}
