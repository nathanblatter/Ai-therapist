// Analytics panel (ai-therapist-84): weekly rubric-score trend (one line per
// ai_model + prompt_version group) with a dimension/range selector, plus an
// open-drift-alert banner with Acknowledge. Self-fetching; ToolUsagePanel
// pattern. Scores are only comparable within a prompt_version.
import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, TrendingDown } from 'react-feather';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { toast } from '../../shared/components/Toast';

// 8-color cycle: the 4 Analytics brand colors + 4 extensions.
const COLORS = ['#0047BA', '#002E5D', '#BDD6E6', '#8B959E', '#7A9CC6', '#4C6E91', '#A3B9CC', '#5B6770'];

const DIMENSIONS: Array<[string, string]> = [
  ['safety_protocol', 'Safety protocol'],
  ['empathy', 'Empathy / reflective listening'],
  ['modality_fidelity', 'Modality fidelity'],
  ['disclaimer_compliance', 'Disclaimer compliance'],
  ['non_directiveness', 'Non-directiveness'],
  ['clinical_claims', 'No hallucinated clinical claims'],
];

interface EvalTrendRow {
  week: string;
  ai_model: string | null;
  prompt_version: string;
  dimension: string;
  mean_score: number;
  n: number;
}

interface DriftAlert {
  alert_id: number;
  dimension: string;
  ai_model: string | null;
  prompt_version: string;
  rolling_mean: number;
  baseline_mean: number;
  drop_amount: number;
  window_n: number;
  baseline_n: number;
  created_at: string;
}

interface EvalTrendData {
  trend: EvalTrendRow[];
  open_alerts: DriftAlert[];
}

export default function EvalDriftPanel() {
  const [data, setData] = useState<EvalTrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimension, setDimension] = useState('safety_protocol');
  const [weeks, setWeeks] = useState(12);
  const [alerts, setAlerts] = useState<DriftAlert[]>([]);

  const load = useCallback((w: number) => {
    setLoading(true);
    fetch(`/admin/api/analytics/evals?weeks=${w}`)
      .then(r => { if (!r.ok) throw new Error('Failed to fetch eval trend'); return r.json(); })
      .then((d: EvalTrendData) => { setData(d); setAlerts(d.open_alerts ?? []); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(weeks); }, [load, weeks]);

  const acknowledge = async (alertId: number) => {
    try {
      const res = await fetch(`/admin/api/evals/drift-alerts/${alertId}/ack`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAlerts(prev => prev.filter(a => a.alert_id !== alertId));
      toast.success('Alert acknowledged');
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
      toast.error('Failed to acknowledge alert');
    }
  };

  if (loading && !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-gray-500 text-center py-4">Loading eval trend...</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-red-600 text-center py-4">{error || 'No eval trend available'}</p>
      </div>
    );
  }

  // Build chart data for the selected dimension: pivot rows into
  // { week, [group]: mean_score } with one series per (ai_model · prompt_version).
  const rows = data.trend.filter(r => r.dimension === dimension);
  const groupKey = (r: EvalTrendRow) => `${r.ai_model ?? 'unknown'} · ${r.prompt_version}`;
  const groups = Array.from(new Set(rows.map(groupKey))).sort();
  const weeksSorted = Array.from(new Set(rows.map(r => r.week))).sort();
  const nByGroupWeek = new Map<string, number>();
  const chartData = weeksSorted.map(week => {
    const point: Record<string, string | number> = { week };
    for (const r of rows.filter(x => x.week === week)) {
      point[groupKey(r)] = r.mean_score;
      nByGroupWeek.set(`${groupKey(r)}|${week}`, r.n);
    }
    return point;
  });

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold flex items-center gap-2">
        <TrendingDown size={20} /> Eval Score Drift
      </h3>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map(a => (
            <div key={a.alert_id} className="bg-white border-2 border-red-400 rounded-lg p-4 flex items-start justify-between gap-4">
              <div className="flex items-start gap-2">
                <AlertTriangle size={18} className="text-red-600 mt-0.5 shrink-0" />
                <p className="text-sm text-gray-800">
                  <span className="font-semibold">{a.dimension}</span> dropped {a.drop_amount} pts
                  (rolling {a.rolling_mean} vs baseline {a.baseline_mean}, n={a.window_n}) — model{' '}
                  {a.ai_model ?? 'unknown'} · prompt {a.prompt_version} · {new Date(a.created_at).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => acknowledge(a.alert_id)}
                className="px-3 py-1.5 bg-royal text-white rounded hover:bg-navy transition text-sm shrink-0 min-h-[36px]"
              >
                Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <h4 className="text-lg font-semibold">Weekly mean score</h4>
          <div className="flex gap-2">
            <select
              value={dimension}
              onChange={e => setDimension(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              {DIMENSIONS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <select
              value={weeks}
              onChange={e => setWeeks(Number(e.target.value))}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              {[4, 12, 26, 52].map(w => (
                <option key={w} value={w}>{w} weeks</option>
              ))}
            </select>
          </div>
        </div>

        {chartData.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No evals in this window.</p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} />
              <YAxis domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} />
              <Tooltip
                formatter={(value, name, item) => {
                  const week = (item?.payload as Record<string, unknown> | undefined)?.week as string;
                  const n = nByGroupWeek.get(`${String(name)}|${week}`);
                  return [`${Number(value).toFixed(2)}${n !== undefined ? ` (n=${n})` : ''}`, String(name)];
                }}
              />
              <Legend />
              {groups.map((g, i) => (
                <Line key={g} type="monotone" dataKey={g} name={g} stroke={COLORS[i % COLORS.length]} dot={{ r: 2 }} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Scores are only comparable within a prompt_version. Alerts fire when a dimension's rolling mean
        (last <code>drift_window</code>, default 20) drops ≥ <code>drift_threshold</code> (default 0.5)
        below the prior baseline (default 100). Configure via system_config key <code>evals</code>{' '}
        (<code>drift_window</code> / <code>drift_baseline</code> / <code>drift_threshold</code> /{' '}
        <code>drift_page_enabled</code>).
      </p>
    </div>
  );
}
