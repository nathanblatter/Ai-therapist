import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, Clock, Trash2, ExternalLink } from 'react-feather';

interface Chunk {
  chunk_id: number;
  kind: string;
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  modality: string | null;
  active: boolean;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  created_at: string;
}

interface StatusCount { kind: string; active: number; pending: number; }

const KINDS = ['psychoeducation', 'worksheet', 'technique'];

export default function KnowledgeBase() {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [counts, setCounts] = useState<StatusCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('');
  const [status, setStatus] = useState<string>('pending');
  const [busy, setBusy] = useState<number | 'bulk' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (status) params.set('status', status);
      const res = await fetch(`/admin/api/knowledge?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setChunks(data.chunks ?? []);
      setCounts(data.counts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [kind, status]);

  useEffect(() => { load(); }, [load]);

  const setActive = async (id: number, active: boolean) => {
    // Approvals are recorded with the admin's identity + an optional rationale
    // note (ai-therapist-88 audit trail). Ask for the note only on approve.
    let note: string | null = null;
    if (active) {
      note = window.prompt('Approval note (optional — recorded in the audit trail):', '');
      if (note === null) return; // cancelled
    }
    setBusy(id);
    try {
      const res = await fetch(`/admin/api/knowledge/${id}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ active, note: note || undefined }),
      });
      if (!res.ok) throw new Error('update failed');
      await load();
    } catch {
      setError('Could not update that item.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this content permanently? This cannot be undone.')) return;
    setBusy(id);
    try {
      const res = await fetch(`/admin/api/knowledge/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('delete failed');
      await load();
    } catch {
      setError('Could not delete that item.');
    } finally {
      setBusy(null);
    }
  };

  const approveAll = async () => {
    const scope = kind ? `all pending ${kind}` : 'ALL pending';
    if (!confirm(`Approve ${scope} content? It becomes retrievable in live sessions.`)) return;
    const note = window.prompt('Approval note for this batch (optional — recorded in the audit trail):', '');
    if (note === null) return; // cancelled
    setBusy('bulk');
    try {
      const res = await fetch('/admin/api/knowledge/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...(kind ? { kind } : {}), ...(note ? { note } : {}) }),
      });
      if (!res.ok) throw new Error('approve failed');
      await load();
    } catch {
      setError('Bulk approve failed.');
    } finally {
      setBusy(null);
    }
  };

  const totalActive = counts.reduce((n, c) => n + c.active, 0);
  const totalPending = counts.reduce((n, c) => n + c.pending, 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Knowledge Base</h2>
        <p className="text-sm text-gray-600 mt-1">
          Curate the content the AI can retrieve (psychoeducation, worksheets, techniques).
          Only <strong>approved</strong> content is used in live sessions — approve items as they clear review.
        </p>
      </div>

      {/* Status summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Active (live)</p>
          <p className="text-2xl font-bold text-emerald-600">{totalActive}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-xs text-gray-500">Pending approval</p>
          <p className="text-2xl font-bold text-amber-600">{totalPending}</p>
        </div>
        {counts.map(c => (
          <div key={c.kind} className="bg-white rounded-lg shadow p-4">
            <p className="text-xs text-gray-500 capitalize">{c.kind}</p>
            <p className="text-sm font-semibold text-gray-900">{c.active} active · <span className="text-amber-600">{c.pending} pending</span></p>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select value={kind} onChange={e => setKind(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All kinds</option>
          {KINDS.map(k => <option key={k} value={k} className="capitalize">{k}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">All statuses</option>
          <option value="pending">Pending only</option>
          <option value="active">Active only</option>
        </select>
        <button
          onClick={approveAll}
          disabled={busy === 'bulk' || totalPending === 0}
          className="ml-auto px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-40"
        >
          {busy === 'bulk' ? 'Approving…' : `Approve all pending${kind ? ` ${kind}` : ''}`}
        </button>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-gray-500 p-8 text-center">Loading…</div>
      ) : chunks.length === 0 ? (
        <div className="text-gray-500 p-8 text-center bg-white rounded-lg shadow">No content matches this filter.</div>
      ) : (
        <div className="space-y-3">
          {chunks.map(c => (
            <div key={c.chunk_id} className="bg-white rounded-lg shadow p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${c.active ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                      {c.active ? <CheckCircle size={12} /> : <Clock size={12} />}
                      {c.active ? 'Active' : 'Pending'}
                    </span>
                    <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 capitalize">{c.kind}</span>
                    {c.topic && <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{c.topic}</span>}
                    {c.modality && <span className="px-2 py-0.5 rounded text-xs bg-indigo-100 text-indigo-700 uppercase">{c.modality}</span>}
                  </div>
                  <p className="font-semibold text-gray-900 mt-2">{c.title ?? '(untitled)'}</p>
                  <p className="text-sm text-gray-600 mt-1">{c.content}</p>
                  <p className="text-xs text-gray-400 mt-2 flex items-center gap-1 flex-wrap">
                    <span>{c.source}</span>
                    {c.source_url && (
                      <a href={c.source_url} target="_blank" rel="noreferrer" className="text-royal inline-flex items-center gap-0.5 hover:underline">
                        source <ExternalLink size={10} />
                      </a>
                    )}
                    {c.license && <span>· {c.license}</span>}
                  </p>
                  {c.active && c.approved_by && (
                    <p className="text-xs text-gray-500 mt-1">
                      Approved by <strong>{c.approved_by}</strong>
                      {c.approved_at && ` · ${new Date(c.approved_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`}
                      {c.approval_note && <span className="italic text-gray-400"> — {c.approval_note}</span>}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  {c.active ? (
                    <button onClick={() => setActive(c.chunk_id, false)} disabled={busy === c.chunk_id}
                      className="px-3 py-1.5 text-xs rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40">
                      Unapprove
                    </button>
                  ) : (
                    <button onClick={() => setActive(c.chunk_id, true)} disabled={busy === c.chunk_id}
                      className="px-3 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">
                      Approve
                    </button>
                  )}
                  <button onClick={() => remove(c.chunk_id)} disabled={busy === c.chunk_id}
                    className="px-3 py-1.5 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 inline-flex items-center justify-center gap-1 disabled:opacity-40">
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
