// Simulation Runs panel (ai-therapist-124): the admin control surface for the
// eval harness. Run-now controls + live status (spawns the harness as a child
// process server-side), a nightly schedule (evals.harness_schedule), the
// persisted run list + pass-rate trend, and a per-run scenario table linking
// each result to its therapy session — which opens SessionDetail with the
// transcript and, for voice runs, the playable recording. Self-fetching;
// EvalDriftPanel pattern.
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, CheckCircle, XCircle, ExternalLink, Cpu, Play, Clock, Save } from 'react-feather';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { toast } from '../../shared/components/Toast';

const SUITES = ['voice', 'quality', 'smoke', 'full', 'replay'] as const;
type Suite = (typeof SUITES)[number];

interface RunnerStatus {
  running: boolean;
  suite?: string;
  trigger?: string;
  startedAt?: string;
  logTail: string[];
  lastExit?: { code: number | null; at: string; suite: string };
  schedule?: HarnessSchedule;
}

interface HarnessSchedule {
  enabled: boolean;
  suite: Suite;
  hour_utc: number;
  variations: number;
}

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

  // Run-now + schedule controls
  const [runSuite, setRunSuite] = useState<Suite>('voice');
  const [runVariations, setRunVariations] = useState(1);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [schedule, setSchedule] = useState<HarnessSchedule>({ enabled: false, suite: 'voice', hour_utc: 9, variations: 1 });
  const [savingSchedule, setSavingSchedule] = useState(false);
  const wasRunning = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/admin/api/harness/runs', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Failed to fetch simulation runs'); return r.json(); })
      .then(data => { setRuns(data.runs ?? []); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, []);

  const loadStatus = useCallback(() => {
    fetch('/admin/api/harness/status', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((s: RunnerStatus | null) => {
        if (!s) return;
        setStatus(s);
        if (s.schedule) setSchedule(prev => (savingSchedule ? prev : s.schedule!));
      })
      .catch(() => { /* status is best-effort */ });
  }, [savingSchedule]);

  useEffect(() => { load(); loadStatus(); }, [load, loadStatus]);

  // Poll status every 3s while a run is live; refresh the run list when it ends.
  useEffect(() => {
    if (!status?.running) {
      if (wasRunning.current) { wasRunning.current = false; load(); }
      return;
    }
    wasRunning.current = true;
    const t = setInterval(loadStatus, 3000);
    return () => clearInterval(t);
  }, [status?.running, loadStatus, load]);

  const startRun = () => {
    setStarting(true);
    fetch('/admin/api/harness/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ suite: runSuite, variations: runVariations }),
    })
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || 'Failed to start run');
        toast.success(`Started ${runSuite} run`);
        loadStatus();
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to start run'))
      .finally(() => setStarting(false));
  };

  const saveSchedule = () => {
    setSavingSchedule(true);
    fetch('/admin/api/harness/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(schedule),
    })
      .then(async r => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || 'Failed to save schedule');
        setSchedule(body.schedule);
        toast.success(body.schedule.enabled
          ? `Nightly ${body.schedule.suite} run scheduled for ${String(body.schedule.hour_utc).padStart(2, '0')}:00 UTC`
          : 'Nightly run disabled');
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to save schedule'))
      .finally(() => setSavingSchedule(false));
  };

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

      {/* Run now + nightly schedule */}
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <div className="border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Play size={16} className="text-gray-500" />
            <h4 className="text-sm font-semibold">Run now</h4>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={runSuite}
              onChange={e => setRunSuite(e.target.value as Suite)}
              className="border rounded-lg px-2 py-1.5 text-sm"
            >
              {SUITES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="text-sm text-gray-600 flex items-center gap-1">
              variations
              <input
                type="number" min={1} max={5} value={runVariations}
                onChange={e => setRunVariations(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                className="w-14 border rounded-lg px-2 py-1.5 text-sm"
                disabled={runSuite === 'replay'}
              />
            </label>
            <button
              onClick={startRun}
              disabled={starting || status?.running}
              className="flex items-center gap-2 px-4 py-1.5 bg-royal text-white rounded-lg text-sm hover:opacity-90 disabled:opacity-50 transition"
            >
              <Play size={14} />
              {status?.running ? 'Run in progress' : 'Start run'}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Voice runs open real Realtime sessions (a few minutes, real API spend) and leave playable recordings.
            Replay re-drives recent redacted sessions through the current pipeline.
          </p>
          {status?.running && (
            <div className="mt-3">
              <p className="text-sm text-gray-700 flex items-center gap-2">
                <RefreshCw size={13} className="animate-spin" />
                {status.suite} run ({status.trigger}) since {status.startedAt ? new Date(status.startedAt).toLocaleTimeString() : ''}
              </p>
              {status.logTail.length > 0 && (
                <pre className="mt-2 max-h-36 overflow-y-auto bg-gray-900 text-gray-100 text-xs rounded p-2">
                  {status.logTail.slice(-12).join('\n')}
                </pre>
              )}
            </div>
          )}
          {!status?.running && status?.lastExit && (
            <p className="mt-2 text-xs text-gray-500">
              Last run: {status.lastExit.suite} finished {new Date(status.lastExit.at).toLocaleString()}
              {status.lastExit.code === 0 ? ' (ok)' : ` (exit ${status.lastExit.code ?? 'killed'})`}
            </p>
          )}
        </div>

        <div className="border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} className="text-gray-500" />
            <h4 className="text-sm font-semibold">Nightly run</h4>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-gray-700 flex items-center gap-2">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={e => setSchedule({ ...schedule, enabled: e.target.checked })}
              />
              enabled
            </label>
            <select
              value={schedule.suite}
              onChange={e => setSchedule({ ...schedule, suite: e.target.value as Suite })}
              className="border rounded-lg px-2 py-1.5 text-sm"
            >
              {SUITES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="text-sm text-gray-600 flex items-center gap-1">
              at
              <input
                type="number" min={0} max={23} value={schedule.hour_utc}
                onChange={e => setSchedule({ ...schedule, hour_utc: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                className="w-14 border rounded-lg px-2 py-1.5 text-sm"
              />
              :00 UTC
            </label>
            <label className="text-sm text-gray-600 flex items-center gap-1">
              variations
              <input
                type="number" min={1} max={5} value={schedule.variations}
                onChange={e => setSchedule({ ...schedule, variations: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
                className="w-14 border rounded-lg px-2 py-1.5 text-sm"
              />
            </label>
            <button
              onClick={saveSchedule}
              disabled={savingSchedule}
              className="flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50 transition"
            >
              <Save size={14} />
              Save
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {schedule.enabled
              ? `Runs the ${schedule.suite} suite nightly at ${String(schedule.hour_utc).padStart(2, '0')}:00 UTC (${new Date(Date.UTC(2000, 0, 1, schedule.hour_utc)).toLocaleTimeString([], { hour: 'numeric' })} local).`
              : 'Disabled — runs only when started manually or by CI.'}
          </p>
        </div>
      </div>

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
