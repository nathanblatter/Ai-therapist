// Simulation Runs panel (ai-therapist-124 phase 3): harness (red-team /
// quality / voice) eval runs persisted by the CLI. Run list + pass-rate trend,
// and a per-run scenario table linking each result to its therapy session —
// which opens SessionDetail with the transcript and, for voice runs, the
// playable recording. Self-fetching; EvalDriftPanel pattern.
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, ExternalLink, Cpu } from 'react-feather';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface HarnessRun {
  id: number;
  started_at: string;
  finished_at: string;
  suite: string;
  seed: number;
  variations: number;
  judge_model: string | null;
  git_sha: string | null;
  trigger: string;
  dry_run: boolean;
  scenario_count: number;
  pass_count: number;
  est_cost_usd: string;
}

interface HarnessScenarioResult {
  id: number;
  scenario_id: string;
  variation: number;
  pipeline: string;
  passed: boolean;
  assertion_failures: Array<{ id: string; detail: string }>;
  judge_scores: Record<string, number> | null;
  session_id: string | null;
  error: string | null;
  duration_ms: number;
  cost_usd: string;
}

function judgeSummary(scores: Record<string, number> | null): string {
  if (!scores) return '—';
  const vals = Object.values(scores).filter(v => typeof v === 'number');
  if (vals.length === 0) return '—';
  const min = Math.min(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return `min ${min} · mean ${mean.toFixed(1)}`;
}

export default function SimulationRunsPanel({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [results, setResults] = useState<HarnessScenarioResult[] | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/admin/api/harness/runs', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Failed to fetch simulation runs'); return r.json(); })
      .then(data => { setRuns(data.runs ?? []); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (selectedId == null) { setResults(null); return; }
    setResultsLoading(true);
    fetch(`/admin/api/harness/runs/${selectedId}`, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Failed to fetch run detail'); return r.json(); })
      .then(data => setResults(data.results ?? []))
      .catch(() => setResults([]))
      .finally(() => setResultsLoading(false));
  }, [selectedId]);

  // Oldest-to-newest pass-rate trend, live (non-dry) runs only.
  const trend = runs
    .filter(r => !r.dry_run)
    .slice()
    .reverse()
    .map(r => ({
      label: `#${r.id}`,
      passRate: r.scenario_count > 0 ? Math.round((r.pass_count / r.scenario_count) * 100) : 0,
    }));

  return (
    <div className="bg-white rounded-lg border shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Cpu size={20} className="text-gray-500" />
          <h3 className="text-lg font-semibold">Simulation Runs</h3>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50 transition"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>}

      {!loading && runs.length === 0 && !error && (
        <p className="text-sm text-gray-500">
          No runs recorded yet. Harness runs (npm run redteam:*) persist here once migration 063 is applied.
        </p>
      )}

      {trend.length >= 2 && (
        <div className="h-40 mb-6">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
              <Tooltip formatter={value => [`${Number(value)}%`, 'pass rate']} />
              <Line type="monotone" dataKey="passRate" stroke="#0047BA" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-gray-400 border-b">
                <th className="py-2 pr-4">Run</th>
                <th className="py-2 pr-4">Started</th>
                <th className="py-2 pr-4">Suite</th>
                <th className="py-2 pr-4">Trigger</th>
                <th className="py-2 pr-4">Passed</th>
                <th className="py-2 pr-4">Cost</th>
                <th className="py-2 pr-4">Commit</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr
                  key={run.id}
                  onClick={() => setSelectedId(selectedId === run.id ? null : run.id)}
                  className={`border-b cursor-pointer transition ${selectedId === run.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <td className="py-2 pr-4 font-mono">#{run.id}{run.dry_run ? ' (dry)' : ''}</td>
                  <td className="py-2 pr-4">{new Date(run.started_at).toLocaleString()}</td>
                  <td className="py-2 pr-4">{run.suite}{run.variations > 1 ? ` ×${run.variations}` : ''}</td>
                  <td className="py-2 pr-4">{run.trigger}</td>
                  <td className={`py-2 pr-4 font-medium ${run.pass_count === run.scenario_count ? 'text-green-700' : 'text-red-700'}`}>
                    {run.pass_count}/{run.scenario_count}
                  </td>
                  <td className="py-2 pr-4">${Number(run.est_cost_usd).toFixed(4)}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-gray-500">{run.git_sha ? run.git_sha.slice(0, 8) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId != null && (
        <div className="mt-4 border rounded-lg p-4 bg-gray-50">
          <h4 className="text-sm font-semibold mb-2">Run #{selectedId} scenarios</h4>
          {resultsLoading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : results && results.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-gray-400 border-b">
                    <th className="py-2 pr-4">Scenario</th>
                    <th className="py-2 pr-4">Pipeline</th>
                    <th className="py-2 pr-4">Result</th>
                    <th className="py-2 pr-4">Judge</th>
                    <th className="py-2 pr-4">Session</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => (
                    <tr key={r.id} className="border-b align-top">
                      <td className="py-2 pr-4">
                        <span className="font-mono">{r.scenario_id}{r.variation > 0 ? `#v${r.variation + 1}` : ''}</span>
                        {r.assertion_failures.length > 0 && (
                          <ul className="mt-1 text-xs text-red-700 list-disc pl-4">
                            {r.assertion_failures.map(f => <li key={f.id}>{f.id}: {f.detail}</li>)}
                          </ul>
                        )}
                        {r.error && <p className="mt-1 text-xs text-red-700">error: {r.error}</p>}
                      </td>
                      <td className="py-2 pr-4">{r.pipeline}</td>
                      <td className="py-2 pr-4">
                        {r.passed
                          ? <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle size={14} /> pass</span>
                          : <span className="inline-flex items-center gap-1 text-red-700"><XCircle size={14} /> fail</span>}
                      </td>
                      <td className="py-2 pr-4 text-xs text-gray-600">{judgeSummary(r.judge_scores)}</td>
                      <td className="py-2 pr-4">
                        {r.session_id && onViewSession ? (
                          <button
                            onClick={() => onViewSession(r.session_id!)}
                            className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                            title="Open transcript and recording"
                          >
                            <ExternalLink size={13} /> open
                          </button>
                        ) : (
                          <span className="text-gray-400 text-xs">{r.session_id ?? '—'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No scenario rows for this run.</p>
          )}
        </div>
      )}
    </div>
  );
}
