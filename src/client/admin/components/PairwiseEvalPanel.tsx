// Analytics panel (ai-therapist-81): pairwise A/B eval win-rates with 95%
// Wilson confidence intervals from the position-debiased judge. Self-fetching;
// follows the ToolUsagePanel pattern.
import { useState, useEffect } from 'react';
import { GitMerge } from 'react-feather';

interface Comparison {
  comparison_axis: string;
  arm_x: string;
  arm_y: string;
  wins_x: number;
  wins_y: number;
  ties: number;
  inconsistent: number;
  total: number;
  win_rate_x: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  significant: boolean;
}

interface PairwiseData {
  prompt_version: string;
  comparisons: Comparison[];
}

const AXIS_LABELS: Record<string, string> = {
  ai_model: 'AI model',
  proactive_offering: 'Proactive offering',
};

function pct(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`;
}

export default function PairwiseEvalPanel() {
  const [data, setData] = useState<PairwiseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/admin/api/analytics/pairwise')
      .then(r => { if (!r.ok) throw new Error('Failed to fetch pairwise analytics'); return r.json(); })
      .then((d: PairwiseData) => setData(d))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-gray-500 text-center py-4">Loading pairwise eval...</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-red-600 text-center py-4">{error || 'No pairwise data available'}</p>
      </div>
    );
  }

  const byAxis = new Map<string, Comparison[]>();
  for (const c of data.comparisons) {
    const arr = byAxis.get(c.comparison_axis) ?? [];
    arr.push(c);
    byAxis.set(c.comparison_axis, arr);
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold flex items-center gap-2">
        <GitMerge size={20} /> Pairwise A/B Eval (position-debiased judge)
      </h3>

      {data.comparisons.length === 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <p className="text-gray-500">
            No pairwise results yet — run{' '}
            <code className="bg-gray-100 px-1 rounded">npx tsx src/database/scripts/runPairwiseEvals.ts --axis ai_model</code>.
          </p>
        </div>
      )}

      {[...byAxis.entries()].map(([axis, comparisons]) => (
        <div key={axis} className="bg-white p-6 rounded-lg shadow overflow-x-auto">
          <h4 className="text-lg font-semibold mb-3">{AXIS_LABELS[axis] ?? axis}</h4>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Comparison</th>
                <th className="py-2 pr-4">n</th>
                <th className="py-2 pr-4">X wins</th>
                <th className="py-2 pr-4">Y wins</th>
                <th className="py-2 pr-4">Ties (incons.)</th>
                <th className="py-2 pr-4">Win-rate X</th>
                <th className="py-2 pr-4">95% CI</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((c, i) => {
                const winClass = c.significant
                  ? c.win_rate_x !== null && c.win_rate_x > 0.5
                    ? 'text-green-700 font-bold'
                    : 'text-red-700 font-bold'
                  : '';
                return (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{c.arm_x} vs {c.arm_y}</td>
                    <td className="py-2 pr-4">{c.total}</td>
                    <td className="py-2 pr-4">{c.wins_x}</td>
                    <td className="py-2 pr-4">{c.wins_y}</td>
                    <td className="py-2 pr-4">{c.ties} ({c.inconsistent})</td>
                    <td className={`py-2 pr-4 ${winClass}`}>{pct(c.win_rate_x)}</td>
                    <td className="py-2 pr-4 text-gray-600">
                      {c.ci_lo === null ? '—' : `[${pct(c.ci_lo)}, ${pct(c.ci_hi)}]`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <p className="text-xs text-gray-500">
        Win-rate X = wins_x / (wins_x + wins_y); ties and position-inconsistent verdicts are excluded from
        the interval (they answer "when the judge picked a side, how often was it X?"). A 95% Wilson CI that
        excludes 50% is significant (≈ p&lt;.05). Run a batch:{' '}
        <code className="bg-gray-100 px-1 rounded">npx tsx src/database/scripts/runPairwiseEvals.ts --axis ai_model</code>.
      </p>
    </div>
  );
}
