// Analytics panel (ai-therapist-80): judge calibration — quadratic weighted
// kappa between human ratings and the LLM judge, per rubric dimension, with an
// auto-run readiness badge. Self-fetching; follows the ToolUsagePanel pattern.
import { useState, useEffect, useCallback } from 'react';
import { getJson } from '../../shared/http';
import { CheckCircle, AlertTriangle, Users } from 'react-feather';

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

interface JudgePairDimension {
  dimension: string;
  n: number;
  kappa: number | null;
  exact_agreement_pct: number | null;
  mean_bias: number | null;
  major_disagreement_pct: number | null;
}

interface JudgePairAgreement {
  judge_a: string;
  judge_b: string;
  n: number;
  dimensions: JudgePairDimension[];
  overall_kappa: number | null;
}

interface SelfConsistencyReport {
  judge_model: string;
  runs: number;
  n: number;
  dimensions: Array<{ dimension: string; n: number; exact_pct: number | null; mean_spread: number | null }>;
}

interface JudgeAgreementReport {
  prompt_version: string;
  judges: string[];
  session_count: number;
  pairs: JudgePairAgreement[];
  self_consistency: SelfConsistencyReport[];
  high_disagreement: Array<{ session_id: string; max_spread: number; judge_spread: Record<string, number> }>;
}

interface HumanAgreementReport {
  rubric_version: string;
  pair_count: number;
  session_count: number;
  pairs_needed: number;
  target_pairs: number;
  dimensions: Array<{
    dimension: string;
    n: number;
    kappa: number | null;
    exact_agreement_pct: number | null;
    major_disagreement_pct: number | null;
  }>;
  overall_kappa: number | null;
}

interface CalibrationData {
  report: CalibrationReport;
  available_prompt_versions: string[];
  /** Absent on servers that predate migration 107. */
  judge_agreement?: JudgeAgreementReport;
  /** Absent on servers that predate migration 114. */
  human_agreement?: HumanAgreementReport;
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
    report.dimensions.length > 0 && report.dimensions.every((d) => d.kappa !== null && d.kappa >= 0.6 && d.n >= 20)
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
    getJson<CalibrationData>(`/admin/api/evals/calibration${qs}`, { fallback: 'Failed to fetch calibration' })
      .then((d) => {
        setData(d);
        setPromptVersion(d.report.prompt_version);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const { report, available_prompt_versions, judge_agreement, human_agreement } = data;
  const calibrated = isCalibrated(report);
  const pairsNeeded = Math.max(0, 20 - Math.min(...report.dimensions.map((d) => d.n), 20));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <CheckCircle size={20} /> Judge Calibration (human vs LLM)
        </h3>
        {available_prompt_versions.length > 0 && (
          <select
            value={promptVersion}
            onChange={(e) => {
              setPromptVersion(e.target.value);
              load(e.target.value);
            }}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            {(available_prompt_versions.includes(promptVersion)
              ? available_prompt_versions
              : [promptVersion, ...available_prompt_versions]
            ).map((v) => (
              <option key={v} value={v}>
                prompt {v}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <p className="text-sm text-gray-600">Paired ratings (human vs judge)</p>
          <p className="text-3xl font-bold text-navy mt-2">{report.pair_count}</p>
          <p className="text-xs text-gray-500 mt-1">
            {pairsNeeded > 0
              ? `${pairsNeeded} more needed on every dimension for the >= 20 rule`
              : '>= 20 on every dimension'}
          </p>
          <div className="mt-2 h-1.5 bg-gray-100 rounded">
            <div
              className="h-1.5 bg-royal rounded"
              style={{ width: `${Math.min(100, (Math.min(...report.dimensions.map((d) => d.n), 20) / 20) * 100)}%` }}
            />
          </div>
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
            {report.dimensions.map((d) => (
              <tr key={d.dimension} className="border-b last:border-0">
                <td className="py-2 pr-4">{DIMENSION_LABELS[d.dimension] ?? d.dimension}</td>
                <td className="py-2 pr-4">{d.n}</td>
                <td className={`py-2 pr-4 ${kappaClasses(d.kappa)}`}>
                  {d.kappa === null ? `n/a (n=${d.n})` : d.kappa.toFixed(2)}
                </td>
                <td className="py-2 pr-4 text-gray-600">{d.kappa === null ? '—' : kappaBand(d.kappa)}</td>
                <td className="py-2 pr-4">
                  {d.exact_agreement_pct === null ? '—' : `${d.exact_agreement_pct.toFixed(0)}%`}
                </td>
                <td className="py-2 pr-4">
                  {d.mean_bias === null ? '—' : (d.mean_bias > 0 ? '+' : '') + d.mean_bias.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {human_agreement && <HumanAgreementBlock agreement={human_agreement} />}

      {judge_agreement && <JudgeAgreementBlock agreement={judge_agreement} />}

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
          Enable <code>evals.auto_run_enabled</code> (system_config key <code>evals</code>) only once every dimension
          shows substantial agreement (κ ≥ 0.6) on ≥ 20 paired ratings for the current prompt version. Until then, run
          evals manually and keep rating sessions.
        </p>
      </div>
    </div>
  );
}

/** Human-vs-human inter-rater reliability over double-rated sessions (eval
 *  program WP2): the second-rater fraction of the rating queue feeds this. */
function HumanAgreementBlock({ agreement }: { agreement: HumanAgreementReport }) {
  const { pair_count, session_count, pairs_needed, target_pairs, dimensions, overall_kappa } = agreement;
  const progress = Math.min(100, (session_count / target_pairs) * 100);
  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h4 className="text-lg font-semibold flex items-center gap-2">
          <Users size={18} /> Inter-rater reliability (human vs human)
        </h4>
        <span className="text-sm text-gray-600">
          {session_count} double-rated session{session_count === 1 ? '' : 's'} · {pair_count} rater pair
          {pair_count === 1 ? '' : 's'} · overall κ{' '}
          <span className={kappaClasses(overall_kappa)}>
            {overall_kappa === null ? 'n/a' : overall_kappa.toFixed(2)}
          </span>
        </span>
      </div>
      <div>
        <div className="flex justify-between text-xs text-gray-600 mb-1">
          <span>Progress toward {target_pairs} double-rated sessions</span>
          <span>{pairs_needed > 0 ? `${pairs_needed} to go` : 'target reached'}</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded">
          <div className="h-1.5 bg-royal rounded" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-600 border-b">
              <th className="py-1 pr-4">Dimension</th>
              <th className="py-1 pr-4">n</th>
              <th className="py-1 pr-4">Weighted κ</th>
              <th className="py-1 pr-4">Exact</th>
              <th className="py-1 pr-4">Differ by 2+</th>
            </tr>
          </thead>
          <tbody>
            {dimensions.map((d) => (
              <tr key={d.dimension} className="border-b last:border-0">
                <td className="py-1 pr-4">{DIMENSION_LABELS[d.dimension] ?? d.dimension}</td>
                <td className="py-1 pr-4">{d.n}</td>
                <td className={`py-1 pr-4 ${kappaClasses(d.kappa)}`}>
                  {d.kappa === null ? `n/a (n=${d.n})` : `${d.kappa.toFixed(2)} (${kappaBand(d.kappa)})`}
                </td>
                <td className="py-1 pr-4">
                  {d.exact_agreement_pct === null ? '—' : `${d.exact_agreement_pct.toFixed(0)}%`}
                </td>
                <td className="py-1 pr-4">
                  {d.major_disagreement_pct === null ? '—' : `${d.major_disagreement_pct.toFixed(0)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-600">
        Human-human κ is the ceiling for human-judge κ: a dimension where two trained raters cannot agree is a rubric
        problem, not a judge problem. Double ratings come from the rating queue&apos;s second-rater fraction (
        <code>evals.rating_second_rater_fraction</code>).
      </p>
    </div>
  );
}

/** Judge-vs-judge agreement for the ensemble (migration 107): one table per
 *  judge pair, self-consistency per judge when runs > 1, and the sessions the
 *  judges disagree on most (the best candidates for human rating). */
function JudgeAgreementBlock({ agreement }: { agreement: JudgeAgreementReport }) {
  const { judges, session_count, pairs, self_consistency, high_disagreement } = agreement;
  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h4 className="text-lg font-semibold flex items-center gap-2">
          <Users size={18} /> Judge agreement (LLM vs LLM)
        </h4>
        <span className="text-sm text-gray-600">
          {judges.length} judge{judges.length === 1 ? '' : 's'} · {session_count} session
          {session_count === 1 ? '' : 's'} with stored judge runs
        </span>
      </div>

      {judges.length < 2 && (
        <p className="text-sm text-gray-600">
          Only one judge has stored runs for this prompt version. Set <code>evals.judge_models</code> to two or more
          models (default: gpt-4o-mini + gpt-5-mini) and re-run evals to measure inter-judge agreement.
        </p>
      )}

      {pairs.map((pair) => (
        <div key={`${pair.judge_a}|${pair.judge_b}`} className="overflow-x-auto">
          <p className="text-sm font-medium mb-1">
            <code>{pair.judge_a}</code> vs <code>{pair.judge_b}</code> · n = {pair.n} · overall κ{' '}
            <span className={kappaClasses(pair.overall_kappa)}>
              {pair.overall_kappa === null ? 'n/a' : pair.overall_kappa.toFixed(2)}
            </span>
          </p>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-1 pr-4">Dimension</th>
                <th className="py-1 pr-4">n</th>
                <th className="py-1 pr-4">Weighted κ</th>
                <th className="py-1 pr-4">Exact</th>
                <th className="py-1 pr-4">Differ by 2+</th>
                <th className="py-1 pr-4">Bias (B − A)</th>
              </tr>
            </thead>
            <tbody>
              {pair.dimensions.map((d) => (
                <tr key={d.dimension} className="border-b last:border-0">
                  <td className="py-1 pr-4">{DIMENSION_LABELS[d.dimension] ?? d.dimension}</td>
                  <td className="py-1 pr-4">{d.n}</td>
                  <td className={`py-1 pr-4 ${kappaClasses(d.kappa)}`}>
                    {d.kappa === null ? `n/a` : `${d.kappa.toFixed(2)} (${kappaBand(d.kappa)})`}
                  </td>
                  <td className="py-1 pr-4">
                    {d.exact_agreement_pct === null ? '—' : `${d.exact_agreement_pct.toFixed(0)}%`}
                  </td>
                  <td className="py-1 pr-4">
                    {d.major_disagreement_pct === null ? '—' : `${d.major_disagreement_pct.toFixed(0)}%`}
                  </td>
                  <td className="py-1 pr-4">
                    {d.mean_bias === null ? '—' : (d.mean_bias > 0 ? '+' : '') + d.mean_bias.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {self_consistency.length > 0 && (
        <div className="overflow-x-auto">
          <p className="text-sm font-medium mb-1">Self-consistency (same judge, repeated seeded runs)</p>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-1 pr-4">Judge</th>
                <th className="py-1 pr-4">Runs</th>
                <th className="py-1 pr-4">n</th>
                {self_consistency[0].dimensions.map((d) => (
                  <th key={d.dimension} className="py-1 pr-4">
                    {DIMENSION_LABELS[d.dimension] ?? d.dimension}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {self_consistency.map((sc) => (
                <tr key={sc.judge_model} className="border-b last:border-0">
                  <td className="py-1 pr-4">
                    <code>{sc.judge_model}</code>
                  </td>
                  <td className="py-1 pr-4">{sc.runs}</td>
                  <td className="py-1 pr-4">{sc.n}</td>
                  {sc.dimensions.map((d) => (
                    <td key={d.dimension} className="py-1 pr-4">
                      {d.exact_pct === null ? '—' : `${d.exact_pct.toFixed(0)}% identical`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {high_disagreement.length > 0 && (
        <div>
          <p className="text-sm font-medium mb-1">Highest judge disagreement (candidates for human rating)</p>
          <ul className="text-sm text-gray-700 space-y-1">
            {high_disagreement
              .filter((h) => h.max_spread > 0)
              .map((h) => (
                <li key={h.session_id}>
                  <span className="font-mono text-xs">{h.session_id}</span> · max spread {h.max_spread} ·{' '}
                  {Object.entries(h.judge_spread)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => `${DIMENSION_LABELS[k] ?? k} ${v}`)
                    .join(', ')}
                </li>
              ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-gray-600">
        κ is quadratic-weighted Cohen&apos;s kappa between the two judges&apos; per-session scores (median over
        self-consistency runs) under the same v1 prompt. Low κ with high human agreement for one judge means the other
        judge is miscalibrated; low κ everywhere means the rubric wording is ambiguous on that dimension.
      </p>
    </div>
  );
}
