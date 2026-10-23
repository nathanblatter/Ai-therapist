// Risk calibration panel (eval spec WP3): the latest risk_calibration_runs
// report for the researcher's org - adjudication coverage, precision / recall
// / F1 vs threshold per signal layer, performance at the live bands, the
// F1-maximising threshold next to the current one (ADVISORY ONLY: nothing in
// the UI can change a live threshold), the layer-agreement kappa matrix and
// the unflagged miss-rate sample - plus a Run control. Self-fetching;
// WeeklyDigestPanel pattern. A run with too few adjudicated labels renders
// the counts and says so instead of showing numbers.
import { useState, useEffect, useCallback } from 'react';
import { getJson, postJson } from '../../shared/http';
import { Activity, Play, Info, AlertCircle } from 'react-feather';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { toast } from '../../shared/components/Toast';

// Three validated categorical hues (dataviz palette slots 1, 3, 7; no orange
// in product UI). Precision / recall / F1 keep these in fixed order.
const SERIES = { precision: '#2a78d6', recall: '#1baf7a', f1: '#6250d6' } as const;

interface MetricPoint {
  threshold: number;
  tp: number; fp: number; fn: number; tn: number;
  precision: number | null; recall: number | null; f1: number | null;
}
interface LayerReport {
  key: string; label: string; scale: string; n: number; positives: number;
  grid: MetricPoint[];
  bands: { low: MetricPoint; medium: MetricPoint; high: MetricPoint } | null;
}
interface Recommendation {
  layer: string; current: number; recommended: number | null;
  f1_at_current: number | null; f1_at_recommended: number | null; n: number;
}
interface Agreement {
  layers: string[]; flag_threshold: number;
  kappa: Array<Array<number | null>>; agreement: Array<Array<number | null>>; n: number[][];
}
interface MissRate {
  candidates: number; unflagged_max_score: number; requested: number; sampled: number; scored: number; failed: number;
  budget_exhausted: boolean; ge_50: number; ge_75: number; fraction_ge_50: number | null; fraction_ge_75: number | null;
  spend_usd: number; budget_usd: number; assessor_model: string | null; dry_run: boolean; note: string;
  by_stratum: Array<{ stratum: string; candidates: number; sampled: number; scored: number; ge_50: number; ge_75: number }>;
  sampled_message_ids: number[];
}
interface Report {
  meta: { generated_at: string; git_sha: string; window: { from: string; to: string } };
  label_rule: string;
  labels: {
    scored_messages: number; with_event: number; positives: number; negatives: number;
    negatives_from_false_positive: number; negatives_assumed_unflagged: number;
    excluded_unclear: number; excluded_disputed: number; excluded_unadjudicated: number; excluded_no_event: number;
    unflagged_as_negative: boolean; min_labels_per_class: number; insufficient_labels: boolean;
    coverage: { flagged_events: number; adjudicated_events: number; confirmed: number; false_positive: number; unclear: number; disputed: number };
  };
  current_bands: { low: number; medium: number; high: number };
  layers: LayerReport[];
  agreement: Agreement;
  recommendations: Recommendation[];
  miss_rate: MissRate | null;
}
interface RunSummary {
  run_id: number; org_id: number; started_at: string; finished_at: string | null; created_by: string;
  insufficient_labels: boolean; scored_messages: number; positives: number; negatives: number;
}
interface RunDetail extends RunSummary { params: Record<string, unknown>; report: Report }
interface ListResponse {
  runs: RunSummary[];
  current_bands: { low: number; medium: number; high: number };
  defaults: { sample_size: number; max_sample_size: number; budget_usd: number };
}

const fmt = (v: number | null | undefined, digits = 2): string => (v === null || v === undefined ? 'n/a' : v.toFixed(digits));
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const shortLayer = (k: string): string => k.replace('moderation_self_harm_', 'mod. ').replace('moderation_', 'mod. ').replace('_', ' ');

export default function RiskCalibrationPanel() {
  const [list, setList] = useState<ListResponse | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [sampleSize, setSampleSize] = useState(50);
  const [layerKey, setLayerKey] = useState('composite');

  const load = useCallback(() => {
    setLoading(true);
    getJson<ListResponse>('/admin/api/risk-calibration/runs', { fallback: 'Failed to fetch calibration runs' })
      .then(d => {
        setList(d);
        setSampleSize(d.defaults.sample_size);
        setSelectedId(prev => prev ?? d.runs[0]?.run_id ?? null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (selectedId === null) { setDetail(null); return; }
    getJson<{ run: RunDetail }>(`/admin/api/risk-calibration/runs/${selectedId}`, { fallback: 'Failed to fetch calibration run' })
      .then(d => setDetail(d.run))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Failed to fetch calibration run'));
  }, [selectedId]);

  const startRun = async () => {
    setRunning(true);
    try {
      const d = await postJson<{ run: RunDetail }>('/admin/api/risk-calibration/runs', { sample_size: sampleSize });
      toast.success(`Calibration run #${d.run.run_id} stored`);
      setSelectedId(d.run.run_id);
      load();
    } catch (err) {
      console.error('Failed to run calibration:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to run calibration');
    } finally {
      setRunning(false);
    }
  };

  if (loading && !list) {
    return <div className="bg-white p-6 rounded-lg shadow"><p className="text-gray-500 text-center py-4">Loading risk calibration...</p></div>;
  }
  if (error || !list) {
    return <div className="bg-white p-6 rounded-lg shadow"><p className="text-red-600 text-center py-4">{error || 'No calibration data available'}</p></div>;
  }

  const report = detail?.report ?? null;
  const layer = report?.layers.find(l => l.key === layerKey) ?? report?.layers[0] ?? null;
  const chartData = (layer?.grid ?? []).map(p => ({ threshold: p.threshold, precision: p.precision, recall: p.recall, f1: p.f1 }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <Activity size={20} /> Risk calibration
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          {list.runs.length > 0 && (
            <select
              value={selectedId ?? ''}
              onChange={e => setSelectedId(Number(e.target.value))}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
              aria-label="Calibration run"
            >
              {list.runs.map(r => (
                <option key={r.run_id} value={r.run_id}>
                  #{r.run_id} - {new Date(r.started_at).toLocaleString()} - {r.insufficient_labels ? 'insufficient labels' : `${r.positives}+/${r.negatives}-`}
                </option>
              ))}
            </select>
          )}
          <label className="text-sm text-gray-700 flex items-center gap-1">
            Sample
            <input
              type="number"
              min={0}
              max={list.defaults.max_sample_size}
              value={sampleSize}
              onChange={e => setSampleSize(Math.max(0, Math.min(list.defaults.max_sample_size, Number(e.target.value) || 0)))}
              className="border border-gray-300 rounded px-2 py-1 text-sm w-20"
              aria-label="Miss-rate sample size"
            />
          </label>
          <button
            onClick={startRun}
            disabled={running}
            className="px-3 py-1.5 bg-royal text-white rounded hover:bg-navy transition text-sm flex items-center gap-1 min-h-[36px] disabled:opacity-50"
          >
            <Play size={14} /> {running ? 'Running...' : 'Run calibration'}
          </button>
        </div>
      </div>

      {list.runs.length === 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <p className="text-gray-500 text-center py-6">
            No calibration run yet. Run one here or with{' '}
            <code>npx tsx src/database/scripts/runRiskCalibration.ts</code>. A run reads the scored-message history
            and re-scores up to {list.defaults.sample_size} unflagged messages offline (hard cap ${list.defaults.budget_usd.toFixed(2)}).
          </p>
        </div>
      )}

      {report && (
        <>
          {/* Coverage + label counts */}
          <div className="bg-white p-6 rounded-lg shadow space-y-3">
            <div className="flex items-start justify-between flex-wrap gap-2">
              <h4 className="text-lg font-semibold">Labels and coverage</h4>
              <span className="text-xs text-gray-500">
                Window {report.meta.window.from.slice(0, 10)} to {report.meta.window.to.slice(0, 10)} - generated {new Date(report.meta.generated_at).toLocaleString()} - {report.meta.git_sha}
              </span>
            </div>
            {report.labels.insufficient_labels && (
              <div className="border-2 border-gray-300 rounded-lg p-3 flex items-start gap-2 text-sm text-gray-800">
                <AlertCircle size={18} className="mt-0.5 shrink-0 text-gray-600" />
                <p>
                  <span className="font-semibold">Insufficient labels.</span> Precision / recall need at least{' '}
                  {report.labels.min_labels_per_class} adjudicated positives and {report.labels.min_labels_per_class} negatives; this window has{' '}
                  {report.labels.positives} confirmed and {report.labels.negatives_from_false_positive} false-positive verdicts. Adjudicate crisis
                  events in Crisis Management to grow the ground truth. The layer-agreement matrix and miss-rate sample below need no labels.
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Stat label="Scored messages" value={report.labels.scored_messages} />
              <Stat label="Raised a crisis event" value={report.labels.with_event} />
              <Stat label="Positives (confirmed)" value={report.labels.positives} />
              <Stat label="Negatives" value={report.labels.negatives} sub={`${report.labels.negatives_from_false_positive} false-positive verdicts, ${report.labels.negatives_assumed_unflagged} assumed (no event)`} />
              <Stat label="Flagged events in window" value={report.labels.coverage.flagged_events} />
              <Stat label="Adjudicated" value={report.labels.coverage.adjudicated_events} sub={`${report.labels.coverage.confirmed} confirmed, ${report.labels.coverage.false_positive} false positive, ${report.labels.coverage.unclear} unclear`} />
              <Stat label="Excluded: unadjudicated" value={report.labels.excluded_unadjudicated} />
              <Stat label="Excluded: unclear / disputed" value={report.labels.excluded_unclear + report.labels.excluded_disputed} />
            </div>
            <p className="text-xs text-gray-500 flex items-start gap-1"><Info size={14} className="mt-0.5 shrink-0" /> {report.label_rule}</p>
          </div>

          {/* P/R/F1 curves */}
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <h4 className="text-lg font-semibold">Precision / recall by threshold</h4>
              <select value={layer?.key ?? ''} onChange={e => setLayerKey(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm" aria-label="Signal layer">
                {report.layers.map(l => <option key={l.key} value={l.key}>{l.label} (n={l.n})</option>)}
              </select>
            </div>
            {!layer || layer.grid.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                {layer ? `No curve for ${layer.label}: ${layer.positives} labelled positives of ${layer.n} with a value.` : 'No layer data.'}
              </p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" />
                    <XAxis dataKey="threshold" type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fontSize: 11 }} label={{ value: 'score >= threshold', position: 'insideBottom', offset: -2, fontSize: 11 }} />
                    <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(value, name) => [fmt(typeof value === 'number' ? value : null, 3), String(name)]} labelFormatter={l => `threshold ${l}`} />
                    <Legend />
                    <Line type="monotone" dataKey="precision" name="Precision" stroke={SERIES.precision} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    <Line type="monotone" dataKey="recall" name="Recall" stroke={SERIES.recall} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    <Line type="monotone" dataKey="f1" name="F1" stroke={SERIES.f1} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-xs text-gray-500 mt-2">{layer.label}: {layer.scale}. n={layer.n} labelled messages, {layer.positives} positive.</p>
              </>
            )}
          </div>

          {/* Current bands + recommended thresholds */}
          <div className="bg-white p-6 rounded-lg shadow space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h4 className="text-lg font-semibold">Current bands and recommended thresholds</h4>
              <span className="text-xs font-semibold uppercase tracking-wide border border-gray-400 rounded px-2 py-0.5 text-gray-700">Advisory only</span>
            </div>
            <p className="text-xs text-gray-500">
              Live bands: low {report.current_bands.low}, medium {report.current_bands.medium}, high {report.current_bands.high}. Recommended = the F1-maximising grid threshold
              against the medium band. Nothing here changes a live threshold; that stays a code change decided by Nathan.
            </p>
            {report.layers.every(l => l.bands === null) ? (
              <p className="text-gray-500 text-center py-4">Band performance needs labels (see above).</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-600 border-b">
                      <th className="py-1 pr-3">Layer</th>
                      <th className="py-1 pr-3">n</th>
                      <th className="py-1 pr-3">P / R / F1 at {report.current_bands.low}</th>
                      <th className="py-1 pr-3">at {report.current_bands.medium}</th>
                      <th className="py-1 pr-3">at {report.current_bands.high}</th>
                      <th className="py-1 pr-3">Current</th>
                      <th className="py-1 pr-3">Recommended</th>
                      <th className="py-1 pr-3">F1 current / recommended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.layers.map(l => {
                      const rec = report.recommendations.find(r => r.layer === l.key);
                      const cell = (p: MetricPoint | undefined) => (p ? `${fmt(p.precision)} / ${fmt(p.recall)} / ${fmt(p.f1)}` : 'n/a');
                      return (
                        <tr key={l.key} className="border-b last:border-0">
                          <td className="py-1 pr-3">{l.label}</td>
                          <td className="py-1 pr-3">{l.n}</td>
                          <td className="py-1 pr-3">{cell(l.bands?.low)}</td>
                          <td className="py-1 pr-3">{cell(l.bands?.medium)}</td>
                          <td className="py-1 pr-3">{cell(l.bands?.high)}</td>
                          <td className="py-1 pr-3">{rec ? rec.current : report.current_bands.medium}</td>
                          <td className="py-1 pr-3 font-semibold">{rec?.recommended ?? 'n/a'}</td>
                          <td className="py-1 pr-3">{rec ? `${fmt(rec.f1_at_current)} / ${fmt(rec.f1_at_recommended)}` : 'n/a'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Agreement matrix */}
          <div className="bg-white p-6 rounded-lg shadow space-y-2">
            <h4 className="text-lg font-semibold">Layer agreement (Cohen's kappa, flag at &gt;= {report.agreement.flag_threshold})</h4>
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th className="p-1 text-left text-gray-600"></th>
                    {report.agreement.layers.map(k => <th key={k} className="p-1 text-left text-gray-600 whitespace-nowrap">{shortLayer(k)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {report.agreement.layers.map((row, i) => (
                    <tr key={row}>
                      <th className="p-1 text-left text-gray-600 whitespace-nowrap">{shortLayer(row)}</th>
                      {report.agreement.layers.map((col, j) => {
                        const k = report.agreement.kappa[i][j];
                        const n = report.agreement.n[i][j];
                        // Sequential blue, light to dark with kappa; text stays ink.
                        const alpha = k === null ? 0 : Math.max(0, Math.min(1, k)) * 0.55 + 0.08;
                        return (
                          <td key={col} className="p-1 text-center whitespace-nowrap" style={{ backgroundColor: `rgba(42,120,214,${alpha})` }} title={`n=${n}, raw agreement ${fmt(report.agreement.agreement[i][j])}`}>
                            {k === null ? 'n/a' : fmt(k)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">Computed over messages where both layers have a value; needs no adjudication labels. n/a = one layer never varies.</p>
          </div>

          {/* Miss rate */}
          <div className="bg-white p-6 rounded-lg shadow space-y-3">
            <h4 className="text-lg font-semibold">Unflagged miss-rate sample</h4>
            {!report.miss_rate ? (
              <p className="text-gray-500 text-center py-4">No miss-rate sample in this run.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <Stat label="Unflagged candidates" value={report.miss_rate.candidates} sub={`composite <= ${report.miss_rate.unflagged_max_score} or never scored`} />
                  <Stat label="Sampled / scored / failed" value={`${report.miss_rate.sampled} / ${report.miss_rate.scored} / ${report.miss_rate.failed}`} sub={report.miss_rate.dry_run ? 'dry run: not re-scored' : report.miss_rate.budget_exhausted ? 'stopped at budget cap' : undefined} />
                  <Stat label="Would now score >= 50" value={pct(report.miss_rate.fraction_ge_50)} sub={`${report.miss_rate.ge_50} of ${report.miss_rate.scored}`} />
                  <Stat label="Would now score >= 75" value={pct(report.miss_rate.fraction_ge_75)} sub={`${report.miss_rate.ge_75} of ${report.miss_rate.scored}`} />
                </div>
                <p className="text-xs text-gray-500">
                  Spend ${report.miss_rate.spend_usd.toFixed(4)} of ${report.miss_rate.budget_usd.toFixed(2)} cap
                  {report.miss_rate.assessor_model ? ` on ${report.miss_rate.assessor_model}` : ''}. {report.miss_rate.note}
                </p>
                {report.miss_rate.by_stratum.length > 0 && (
                  <table className="text-sm">
                    <thead><tr className="text-left text-gray-600 border-b"><th className="py-1 pr-3">Stratum</th><th className="py-1 pr-3">Candidates</th><th className="py-1 pr-3">Sampled</th><th className="py-1 pr-3">Scored</th><th className="py-1 pr-3">&gt;= 50</th><th className="py-1 pr-3">&gt;= 75</th></tr></thead>
                    <tbody>
                      {report.miss_rate.by_stratum.map(s => (
                        <tr key={s.stratum} className="border-b last:border-0">
                          <td className="py-1 pr-3">{s.stratum}</td><td className="py-1 pr-3">{s.candidates}</td><td className="py-1 pr-3">{s.sampled}</td>
                          <td className="py-1 pr-3">{s.scored}</td><td className="py-1 pr-3">{s.ge_50}</td><td className="py-1 pr-3">{s.ge_75}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}
