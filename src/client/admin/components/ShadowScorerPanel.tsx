// Shadow scorer panel (ai-therapist-83): where the production crisis pipeline
// and the shadow risk scorer disagree on a participant turn. Read-only: counts,
// the agreement table (production severity by shadow severity) and the list
// of disagreements, for the researcher's organisation. Nothing here can
// change a threshold, a flag or the switch; the scorer never acts on a
// session. Self-fetching, RiskCalibrationPanel pattern.
import { useState, useEffect, useCallback } from 'react';
import { getJson } from '../../shared/http';
import { Layers, Info, RefreshCw, ArrowUp, ArrowDown } from 'react-feather';

type Severity = 'none' | 'low' | 'medium' | 'high';
const SEVERITIES: Severity[] = ['none', 'low', 'medium', 'high'];

interface Disagreement {
  shadow_id: number;
  session_id: string;
  message_id: number | null;
  turn_source: string;
  created_at: string;
  production_score: number;
  production_severity: Severity;
  shadow_severity: Severity;
  p_high: number | null;
  predicates: Record<string, number>;
}
interface ReportResponse {
  enabled: boolean;
  model: string;
  question_set_version: number;
  days: number;
  report: {
    window: { from: string; to: string };
    counts: {
      total: number;
      scored: number;
      errored: number;
      errors: Record<string, number>;
      errored_on_flagged: number;
      agree: number;
      shadow_higher: number;
      shadow_lower: number;
      mean_latency_ms: number | null;
      tokens_in: number;
    };
    agreement: Record<Severity, Record<Severity, number>>;
    disagreements: Disagreement[];
    disagreements_truncated: boolean;
  };
}

const DAY_CHOICES = [7, 30, 90];
const rank = (s: Severity): number => SEVERITIES.indexOf(s);
const pct = (num: number, den: number): string => (den === 0 ? 'n/a' : `${((num / den) * 100).toFixed(1)}%`);

/** The yes/no answers at or above one half, most likely first. A choice
 *  question is stored as one entry per value ("risk_subject.own"); "nobody is
 *  at risk" is the usual answer and is left out. */
function likelyPredicates(p: Record<string, number>): string {
  const hits = Object.entries(p)
    .filter(([k, v]) => v >= 0.5 && k !== 'risk_subject.none')
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ').replace('.', ': ')} ${v.toFixed(2)}`);
  return hits.length > 0 ? hits.join(', ') : 'none at 0.5 or above';
}

export default function ShadowScorerPanel({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getJson<ReportResponse>(`/admin/api/shadow-risk/report?days=${days}`, {
      fallback: 'Failed to fetch the shadow scorer report',
    })
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-gray-500 text-center py-4">Loading shadow scorer...</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-red-600 text-center py-4">{error || 'No shadow scorer data available'}</p>
      </div>
    );
  }

  const { counts, agreement, disagreements } = data.report;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <Layers size={20} /> Shadow scorer
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
            aria-label="Report window"
          >
            {DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 border border-gray-300 rounded text-sm flex items-center gap-1 min-h-[36px] hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="bg-white p-4 rounded-lg shadow text-sm text-gray-700 flex gap-2">
        <Info size={16} className="mt-0.5 shrink-0 text-gray-500" />
        <p>
          A second, independent reading of each participant turn ({data.model}, question set v
          {data.question_set_version}), recorded beside the score the crisis pipeline acted on. It never steers a
          session, raises a flag or pages anyone. It is currently{' '}
          <span className="font-semibold">{data.enabled ? 'on' : 'off'}</span> (system setting{' '}
          <code>shadow_risk_scorer</code>). An errored turn is unknown, not safe.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ['Turns', String(counts.total)],
          ['Answered', String(counts.scored)],
          ['Same severity', `${counts.agree} (${pct(counts.agree, counts.scored)})`],
          ['Shadow higher', String(counts.shadow_higher)],
          ['Shadow lower', String(counts.shadow_lower)],
        ].map(([label, value]) => (
          <div key={label} className="bg-white p-4 rounded-lg shadow">
            <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
            <p className="text-lg font-semibold">{value}</p>
          </div>
        ))}
      </div>

      {counts.errored > 0 && (
        <div className="bg-white p-4 rounded-lg shadow text-sm text-gray-700">
          <p>
            <span className="font-semibold">{counts.errored}</span> turn(s) without an answer (
            {Object.entries(counts.errors)
              .map(([code, n]) => `${code}: ${n}`)
              .join(', ')}
            ); {counts.errored_on_flagged} of them on turns the pipeline scored medium or high. They are left out of the
            table below.
          </p>
        </div>
      )}

      <div className="bg-white p-4 rounded-lg shadow overflow-x-auto">
        <h4 className="font-semibold mb-2">Agreement (turn counts)</h4>
        <table className="text-sm min-w-[420px]">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="pr-4 py-1 font-medium">Production \ Shadow</th>
              {SEVERITIES.map((s) => (
                <th key={s} className="px-3 py-1 font-medium text-right">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEVERITIES.map((p) => (
              <tr key={p} className="border-t border-gray-100">
                <th className="pr-4 py-1 text-left font-medium">{p}</th>
                {SEVERITIES.map((s) => (
                  <td
                    key={s}
                    className={`px-3 py-1 text-right tabular-nums ${p === s ? 'bg-gray-100 font-semibold' : ''}`}
                  >
                    {agreement[p]?.[s] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white p-4 rounded-lg shadow overflow-x-auto">
        <h4 className="font-semibold mb-2">
          Disagreements ({disagreements.length}
          {data.report.disagreements_truncated ? '+' : ''})
        </h4>
        {disagreements.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">
            {counts.total === 0
              ? 'No turns have been shadow-scored in this window.'
              : 'No disagreements in this window.'}
          </p>
        ) : (
          <table className="text-sm w-full min-w-[720px]">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="pr-3 py-1 font-medium">When</th>
                <th className="pr-3 py-1 font-medium">Production</th>
                <th className="pr-3 py-1 font-medium">Shadow</th>
                <th className="pr-3 py-1 font-medium text-right">P(high)</th>
                <th className="pr-3 py-1 font-medium">Shadow says yes to</th>
                <th className="py-1 font-medium">Session</th>
              </tr>
            </thead>
            <tbody>
              {disagreements.map((d) => {
                const higher = rank(d.shadow_severity) > rank(d.production_severity);
                return (
                  <tr key={d.shadow_id} className="border-t border-gray-100 align-top">
                    <td className="pr-3 py-1 whitespace-nowrap">{new Date(d.created_at).toLocaleString()}</td>
                    <td className="pr-3 py-1 whitespace-nowrap">
                      {d.production_severity} ({d.production_score})
                    </td>
                    <td className="pr-3 py-1 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        {higher ? (
                          <ArrowUp size={14} aria-label="higher" />
                        ) : (
                          <ArrowDown size={14} aria-label="lower" />
                        )}
                        {d.shadow_severity}
                      </span>
                    </td>
                    <td className="pr-3 py-1 text-right tabular-nums">
                      {d.p_high === null ? 'n/a' : d.p_high.toFixed(2)}
                    </td>
                    <td className="pr-3 py-1">{likelyPredicates(d.predicates)}</td>
                    <td className="py-1 whitespace-nowrap">
                      {onViewSession ? (
                        <button className="text-royal hover:underline" onClick={() => onViewSession(d.session_id)}>
                          Open{d.turn_source === 'checkin' ? ' (check-in)' : ''}
                        </button>
                      ) : (
                        <span className="font-mono text-xs">{d.session_id.slice(0, 12)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
