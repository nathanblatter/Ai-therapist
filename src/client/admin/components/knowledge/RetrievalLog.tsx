import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle } from 'react-feather';
import { formatDateTime } from './types';

interface RerankStats {
  total: number;
  fallback_rate: number;
  movement_rate: number;
  p95_latency_ms: number | null;
}

interface Decision {
  decision_id: number;
  session_id: string | null;
  tool_name: string;
  query: string;
  candidates: { chunk_id: number; vec_rank: number; similarity: number | null }[];
  chosen: number[];
  used_fallback: boolean;
  model: string | null;
  latency_ms: number | null;
  created_at: string;
}

const TOOLS = ['all', 'retrieve_psychoeducation', 'suggest_worksheet', 'suggest_technique'];

/** Retrieval log: rerank health stats + the recent rag_rerank_decisions rows,
 *  filterable by tool and session (surfacing the previously unused
 *  rerank-decisions endpoint — ai-therapist-116). */
export default function RetrievalLog() {
  const [stats, setStats] = useState<RerankStats | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [tool, setTool] = useState('all');
  const [sessionId, setSessionId] = useState('');
  const [appliedSessionId, setAppliedSessionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (tool !== 'all') params.set('tool', tool);
      if (appliedSessionId) params.set('sessionId', appliedSessionId);
      const res = await fetch(`/admin/api/knowledge/rerank-decisions?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setStats(data.stats ?? null);
      setDecisions(data.decisions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load retrieval log');
    } finally {
      setLoading(false);
    }
  }, [tool, appliedSessionId]);

  useEffect(() => { load(); }, [load]);

  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

  return (
    <div className="space-y-4">
      {/* Rerank health header */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Decisions (recent)</p>
          <p className="text-2xl font-bold text-gray-900">{stats?.total ?? '–'}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Fallback rate</p>
          <p className="text-2xl font-bold text-amber-600">{stats ? pct(stats.fallback_rate) : '–'}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Movement rate</p>
          <p className="text-2xl font-bold text-sky-600">{stats ? pct(stats.movement_rate) : '–'}</p>
          <p className="text-[10px] text-gray-400">rerank changed the winner</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">p95 latency</p>
          <p className="text-2xl font-bold text-gray-900">{stats?.p95_latency_ms != null ? `${stats.p95_latency_ms}ms` : '–'}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select value={tool} onChange={e => setTool(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          {TOOLS.map(t => <option key={t} value={t}>{t === 'all' ? 'All tools' : t}</option>)}
        </select>
        <form
          onSubmit={e => { e.preventDefault(); setAppliedSessionId(sessionId.trim()); }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={sessionId}
            onChange={e => setSessionId(e.target.value)}
            placeholder="Filter by session id"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-64"
          />
          <button type="submit" className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
            Filter
          </button>
          {appliedSessionId && (
            <button type="button" onClick={() => { setSessionId(''); setAppliedSessionId(''); }}
              className="text-xs text-gray-500 hover:underline">
              Clear
            </button>
          )}
        </form>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-gray-500 p-8 text-center">Loading…</div>
      ) : decisions.length === 0 ? (
        <div className="text-gray-500 p-8 text-center bg-white rounded-lg shadow">No rerank decisions match this filter.</div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b">
                <th className="py-2 px-3">Time</th>
                <th className="py-2 px-3">Session</th>
                <th className="py-2 px-3">Tool</th>
                <th className="py-2 px-3">Query</th>
                <th className="py-2 px-3">Candidates → chosen</th>
                <th className="py-2 px-3">Rerank</th>
                <th className="py-2 px-3">Latency</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map(d => (
                <tr key={d.decision_id} className="border-b last:border-0 align-top">
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">{formatDateTime(d.created_at)}</td>
                  <td className="py-2 px-3 text-gray-500 font-mono text-xs max-w-[10rem] truncate" title={d.session_id ?? ''}>
                    {d.session_id ?? '–'}
                  </td>
                  <td className="py-2 px-3 text-gray-700">{d.tool_name}</td>
                  <td className="py-2 px-3 text-gray-600 max-w-xs truncate" title={d.query}>{d.query}</td>
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">
                    {d.candidates.length} → {d.chosen.join(', ') || '–'}
                  </td>
                  <td className="py-2 px-3">
                    {d.used_fallback ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700">
                        <AlertTriangle size={12} /> fallback
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">reranked</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">{d.latency_ms != null ? `${d.latency_ms}ms` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
