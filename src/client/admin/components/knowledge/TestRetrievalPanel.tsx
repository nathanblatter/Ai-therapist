import { useState } from 'react';
import { Search, Zap, AlertTriangle } from 'react-feather';
import { KINDS } from './types';

interface CandidateResult {
  chunk_id: number;
  title: string | null;
  topic: string | null;
  kind: string;
  modality: string | null;
  active: boolean;
  vec_rank: number;
  similarity: number;
  content_preview: string;
}

interface TestResult {
  candidates: CandidateResult[];
  chosen: number[];
  used_fallback: boolean;
  latency_ms: number;
}

/** Test-retrieval playground: run a query through the real embed -> vector
 *  search -> rerank pipeline (without logging a decision row) and show the
 *  vector order vs the reranked order, including which chunk would win. */
export default function TestRetrievalPanel() {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState(KINDS[0]);
  const [topic, setTopic] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/knowledge/test-retrieval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query: query.trim(),
          kind,
          ...(topic.trim() ? { topic: topic.trim() } : {}),
          includeInactive,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Test failed (${res.status})`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test retrieval failed');
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const chosenRank = (chunkId: number): number => result?.chosen.indexOf(chunkId) ?? -1;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4">
        <p className="text-sm text-gray-600 mb-3">
          Run a query through the live retrieval pipeline (embed, vector search, rerank) to see exactly
          what a session would get. Test runs are <strong>not</strong> logged to the retrieval log.
        </p>
        <form onSubmit={run} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs font-medium text-gray-600 mb-1">Query</label>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. why do I feel a tight chest when anxious?"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Kind</label>
            <select value={kind} onChange={e => setKind(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
              {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Topic (optional)</label>
            <input type="text" value={topic} onChange={e => setTopic(e.target.value)} placeholder="any"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-32" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
            Include pending
          </label>
          <button type="submit" disabled={running || !query.trim()}
            className="px-4 py-2 bg-royal text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-2">
            <Search size={14} /> {running ? 'Running…' : 'Test retrieval'}
          </button>
        </form>
        {error && <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
      </div>

      {result && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center gap-3 flex-wrap mb-3 text-sm">
            <span className="text-gray-700 font-medium">{result.candidates.length} candidates</span>
            <span className="text-gray-500">rerank latency {result.latency_ms}ms</span>
            {result.used_fallback ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700">
                <AlertTriangle size={12} /> Fallback: vector order used
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">
                <Zap size={12} /> Reranked
              </span>
            )}
          </div>

          {result.candidates.length === 0 ? (
            <p className="text-sm text-gray-500">No candidates matched. Check kind/topic, or the corpus may have no active content here.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b">
                    <th className="py-2 pr-3">Vec rank</th>
                    <th className="py-2 pr-3">Rerank</th>
                    <th className="py-2 pr-3">Similarity</th>
                    <th className="py-2 pr-3">Chunk</th>
                    <th className="py-2">Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map(c => {
                    const rr = chosenRank(c.chunk_id);
                    const isWinner = rr === 0;
                    return (
                      <tr key={c.chunk_id} className={`border-b last:border-0 align-top ${isWinner ? 'bg-emerald-50' : rr >= 0 ? 'bg-sky-50/50' : ''}`}>
                        <td className="py-2 pr-3 text-gray-600">#{c.vec_rank + 1}</td>
                        <td className="py-2 pr-3">
                          {rr >= 0 ? (
                            <span className={`font-semibold ${isWinner ? 'text-emerald-700' : 'text-sky-700'}`}>
                              #{rr + 1}{isWinner && ' (winner)'}
                            </span>
                          ) : (
                            <span className="text-gray-400">dropped</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-gray-600">{(c.similarity * 100).toFixed(1)}%</td>
                        <td className="py-2 pr-3">
                          <div className="font-medium text-gray-900">{c.title ?? '(untitled)'}</div>
                          <div className="text-xs text-gray-500 flex items-center gap-1 flex-wrap">
                            <span>id {c.chunk_id}</span>
                            {c.topic && <span>· {c.topic}</span>}
                            {!c.active && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">pending</span>}
                          </div>
                        </td>
                        <td className="py-2 text-xs text-gray-600 max-w-md">{c.content_preview}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
