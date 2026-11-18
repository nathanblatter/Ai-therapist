import { useMemo, useState, type FormEvent } from 'react';
import { Search, AlertCircle, RefreshCw, User, MessageSquare, ExternalLink, Info } from 'react-feather';
import { formatDateTime } from '../../shared/format';
import { postJson } from '../../shared/http';

// Researcher semantic search over REDACTED transcripts (ai-therapist-177):
// rank messages by meaning for qualitative sampling and safety-review triage.
// Server: POST /admin/api/semantic-search (semanticSearch.routes.ts). Every
// search is recorded in the data-access log; the query text is sent to the
// embeddings API.

interface SearchHit {
  messageId: string;
  sessionId: string;
  sessionName: string | null;
  sessionStartedAt: string | null;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  similarity: number;
}

interface SearchResponse {
  hits: SearchHit[];
  hasMore: boolean;
  nextOffset: number;
}

interface SessionGroup {
  sessionId: string;
  sessionName: string | null;
  sessionStartedAt: string | null;
  best: number;
  hits: SearchHit[];
}

interface Filters {
  query: string;
  sessionId: string;
  from: string;
  to: string;
  minSimilarity: number;
}

const PAGE_SIZE = 25;

/** Group ranked hits by session, keeping the best-first order of sessions. */
export function groupBySession(hits: SearchHit[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const h of hits) {
    let g = groups.get(h.sessionId);
    if (!g) {
      g = {
        sessionId: h.sessionId,
        sessionName: h.sessionName,
        sessionStartedAt: h.sessionStartedAt,
        best: h.similarity,
        hits: [],
      };
      groups.set(h.sessionId, g);
    }
    g.best = Math.max(g.best, h.similarity);
    g.hits.push(h);
  }
  return [...groups.values()];
}

/** yyyy-mm-dd (local) to an ISO instant; `endOfDay` makes the bound exclusive at the next midnight. */
function dayToIso(day: string, endOfDay: boolean): string | null {
  if (!day) return null;
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export default function SemanticSearch({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [form, setForm] = useState<Filters>({ query: '', sessionId: '', from: '', to: '', minSimilarity: 0.3 });
  const [active, setActive] = useState<Filters | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => groupBySession(hits), [hits]);

  const run = async (filters: Filters, offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await postJson<SearchResponse>(
        '/admin/api/semantic-search',
        {
          query: filters.query,
          sessionId: filters.sessionId.trim() || null,
          from: dayToIso(filters.from, false),
          to: dayToIso(filters.to, true),
          minSimilarity: filters.minSimilarity,
          limit: PAGE_SIZE,
          offset,
        },
        { fallback: 'Search failed' },
      );
      setHits((prev) => (offset === 0 ? data.hits : [...prev, ...data.hits]));
      setHasMore(data.hasMore);
      setNextOffset(data.nextOffset);
      setActive(filters);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (form.query.trim().length < 3) {
      setError('Enter at least 3 characters.');
      return;
    }
    void run({ ...form, query: form.query.trim() }, 0);
  };

  const input = 'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-royal focus:border-royal';

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Search size={24} /> Transcript Search
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Find redacted messages by meaning, e.g. &quot;sessions discussing sleep problems&quot;. Only ended sessions
          whose redaction finished (and was not flagged by the leak check) are searched; text shown is the redacted
          copy.
        </p>
      </div>

      <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 flex gap-2 items-start text-sm text-sky-900">
        <Info size={16} className="shrink-0 mt-0.5 text-sky-600" />
        <span>
          Each search is recorded in the data-access log with your query and the sessions returned. The query text is
          sent to the OpenAI embeddings API, so do not type participant names or other identifiers.
        </span>
      </div>

      <form onSubmit={onSubmit} className="bg-white rounded-lg border shadow-sm p-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <label className="sr-only" htmlFor="semantic-query">
            Search query
          </label>
          <input
            id="semantic-query"
            type="text"
            value={form.query}
            maxLength={500}
            onChange={(e) => setForm({ ...form, query: e.target.value })}
            placeholder="Describe what you are looking for"
            className={`${input} flex-1`}
          />
          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-royal text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {loading ? <RefreshCw size={16} className="animate-spin" /> : <Search size={16} />}
            Search
          </button>
        </div>
        <div className="flex flex-wrap gap-3 items-end text-sm">
          <label className="flex flex-col gap-1 text-gray-600">
            From
            <input
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-gray-600">
            To
            <input
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-gray-600">
            Session ID (optional)
            <input
              type="text"
              value={form.sessionId}
              onChange={(e) => setForm({ ...form, sessionId: e.target.value })}
              className={`${input} font-mono w-72 max-w-full`}
            />
          </label>
          <label className="flex flex-col gap-1 text-gray-600">
            Minimum similarity: {form.minSimilarity.toFixed(2)}
            <input
              type="range"
              min={0}
              max={0.9}
              step={0.05}
              value={form.minSimilarity}
              onChange={(e) => setForm({ ...form, minSimilarity: Number(e.target.value) })}
              className="w-48"
            />
          </label>
        </div>
      </form>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      )}

      {active && !loading && hits.length === 0 && !error && (
        <div className="text-center py-12 bg-white rounded-lg border text-gray-600">
          No redacted messages matched. Try lowering the minimum similarity or widening the dates.
        </div>
      )}

      {groups.length > 0 && (
        <p className="text-sm text-gray-500">
          {hits.length} message{hits.length === 1 ? '' : 's'} in {groups.length} session
          {groups.length === 1 ? '' : 's'}, best match first.
        </p>
      )}

      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.sessionId} className="bg-white rounded-lg border shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-gray-900 truncate">{g.sessionName || 'Untitled session'}</p>
                <p className="text-xs text-gray-500">
                  {formatDateTime(g.sessionStartedAt)} <span className="font-mono ml-1">{g.sessionId}</span>
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">best {g.best.toFixed(2)}</span>
                {onViewSession && (
                  <button
                    onClick={() => onViewSession(g.sessionId)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border rounded-lg hover:bg-gray-100 transition"
                  >
                    <ExternalLink size={14} />
                    Open transcript
                  </button>
                )}
              </div>
            </div>
            <ul className="divide-y">
              {g.hits.map((h) => (
                <li key={h.messageId} className="p-4">
                  <div className="flex items-center gap-3 mb-2">
                    <span
                      className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                        h.role === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {h.role === 'user' ? <User size={12} /> : <MessageSquare size={12} />}
                      {h.role === 'user' ? 'participant' : 'assistant'}
                    </span>
                    <span className="text-xs text-gray-400">{formatDateTime(h.createdAt)}</span>
                    <span className="text-xs text-gray-500 ml-auto">similarity {h.similarity.toFixed(2)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-gray-800">{h.text}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {hasMore && active && (
        <div className="text-center">
          <button
            onClick={() => void run(active, nextOffset)}
            disabled={loading}
            className="inline-flex items-center gap-2 px-6 py-3 bg-white border rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
