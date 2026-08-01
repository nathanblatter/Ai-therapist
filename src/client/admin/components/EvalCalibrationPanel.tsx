// Analytics panel (ai-therapist-80): judge calibration — quadratic weighted
// kappa between human ratings and the LLM judge, per rubric dimension, with an
// auto-run readiness badge. Self-fetching; follows the ToolUsagePanel pattern.
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, AlertTriangle } from 'react-feather';

interface DimensionCalibration {
  dimension: string;
  n: number;
  kappa: number | null;
  human_mean: number | null;
  llm_mean: number | null;
  mean_bias: number | null;
  exact_agreement_pct: number | null;
}

interface CalibrationReport {
  prompt_version: string;
  rubric_version: string;
  pair_count: number;
  session_count: number;
  dimensions: DimensionCalibration[];
  overall_kappa: number | null;
}

interface CalibrationData {
  report: CalibrationReport;
  available_prompt_versions: string[];
}

const DIMENSION_LABELS: Record<string, string> = {
  safety_protocol: 'Safety protocol',
  empathy: 'Empathy / reflective listening',
  modality_fidelity: 'Modality fidelity',
  disclaimer_compliance: 'Disclaimer compliance',
  non_directiveness: 'Non-directiveness',
  clinical_claims: 'No hallucinated clinical claims',
};

function kappaBand(k: number): string {
  if (k >= 0.8) return 'almost perfect';
  if (k >= 0.6) return 'substantial';
  if (k >= 0.4) return 'moderate';
  if (k >= 0.2) return 'fair';
  return 'poor';
}

function kappaClasses(k: number | null): string {
  if (k === null) return 'text-gray-400';
  if (k >= 0.6) return 'text-green-700 font-semibold';
  if (k >= 0.4) return 'text-yellow-700 font-semibold';
  return 'text-red-700 font-semibold';
}

// Auto-run readiness: every dimension κ >= 0.6 on >= 20 paired ratings.
function isCalibrated(report: CalibrationReport): boolean {
  return (
    report.dimensions.length > 0 &&
    report.dimensions.every(d => d.kappa !== null && d.kappa >= 0.6 && d.n >= 20)
  );
}

export default function EvalCalibrationPanel() {
  const [data, setData] = useState<CalibrationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptVersion, setPromptVersion] = useState<string>('');

  const load = useCallback((pv?: string) => {
    setLoading(true);
    const qs = pv ? `?promptVersion=${encodeURIComponent(pv)}` : '';
    fetch(`/admin/api/evals/calibration${qs}`)
      .then(r => { if (!r.ok) throw new Error('Failed to fetch calibration'); return r.json(); })
      .then((d: CalibrationData) => { setData(d); setPromptVersion(d.report.prompt_version); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-gray-500 text-center py-4">Loading judge calibration...</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-red-600 text-center py-4">{error || 'No calibration data available'}</p>
      </div>
    );
  }

  const { report, available_prompt_versions } = data;
  const calibrated = isCalibrated(report);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <CheckCircle size={20} /> Judge Calibration (human vs LLM)
        </h3>
        {available_prompt_versions.length > 0 && (
          <select
            value={promptVersion}
            onChange={e => { setPromptVersion(e.target.value); load(e.target.value); }}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            {(available_prompt_versions.includes(promptVersion)
              ? available_prompt_versions
              : [promptVersion, ...available_prompt_versions]
            ).map(v => (
              <option key={v} value={v}>prompt {v}</option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <p className="text-sm text-gray-600">Paired ratings</p>
          <p className="text-3xl font-bold text-navy mt-2">{report.pair_count}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <p className="text-sm text-gray-600">Sessions</p>
          <p className="text-3xl font-bold text-navy mt-2">{report.session_count}</p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <p className="text-sm text-gray-600">Overall κ</p>
          <p className={`text-3xl font-bold mt-2 ${kappaClasses(report.overall_kappa)}`}>
            {report.overall_kappa === null ? 'n/a' : report.overall_kappa.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-600 border-b">
              <th className="py-2 pr-4">Dimension</th>
              <th className="py-2 pr-4">n</th>
              <th className="py-2 pr-4">Weighted κ (quadratic)</th>
              <th className="py-2 pr-4">Band</th>
              <th className="py-2 pr-4">Exact agreement</th>
              <th className="py-2 pr-4">Mean bias (LLM − human)</th>
            </tr>
          </thead>
          <tbody>
            {report.dimensions.map(d => (
              <tr key={d.dimension} className="border-b last:border-0">
                <td className="py-2 pr-4">{DIMENSION_LABELS[d.dimension] ?? d.dimension}</td>
                <td className="py-2 pr-4">{d.n}</td>
                <td className={`py-2 pr-4 ${kappaClasses(d.kappa)}`}>
                  {d.kappa === null ? `n/a (n=${d.n})` : d.kappa.toFixed(2)}
                </td>
                <td className="py-2 pr-4 text-gray-600">{d.kappa === null ? '—' : kappaBand(d.kappa)}</td>
                <td className="py-2 pr-4">{d.exact_agreement_pct === null ? '—' : `${d.exact_agreement_pct.toFixed(0)}%`}</td>
                <td className="py-2 pr-4">{d.mean_bias === null ? '—' : (d.mean_bias > 0 ? '+' : '') + d.mean_bias.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white p-4 rounded-lg shadow">
        {calibrated ? (
          <span className="inline-flex items-center gap-2 text-green-700 font-semibold">
            <CheckCircle size={16} /> Calibration OK — auto-run safe
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 text-amber-700 font-semibold">
            <AlertTriangle size={16} /> Not yet calibrated — keep auto-run disabled
          </span>
        )}
        <p className="text-xs text-gray-600 mt-2">
          Enable <code>evals.auto_run_enabled</code> (system_config key <code>evals</code>) only once every
          dimension shows substantial agreement (κ ≥ 0.6) on ≥ 20 paired ratings for the current prompt
          version. Until then, run evals manually and keep rating sessions.
        </p>
      </div>
    </div>
  );
}
