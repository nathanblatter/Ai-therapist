import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Search, BookOpen, Target, List } from 'react-feather';
import ChunkCard from './knowledge/ChunkCard';
import ChunkForm from './knowledge/ChunkForm';
import TestRetrievalPanel from './knowledge/TestRetrievalPanel';
import RetrievalLog from './knowledge/RetrievalLog';
import {
  KINDS, EMPTY_FORM, formValuesFromChunk,
  type Chunk, type StatusCount, type ChunkUsage, type ChunkFormValues,
} from './knowledge/types';

const PAGE_SIZE = 50;

type Tab = 'content' | 'test' | 'log';

export default function KnowledgeBase() {
  const [tab, setTab] = useState<Tab>('content');

  // Content tab state
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [counts, setCounts] = useState<StatusCount[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('');
  const [status, setStatus] = useState<string>('pending');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | 'bulk' | null>(null);
  const [approveTopic, setApproveTopic] = useState('');

  // Create / edit
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Usage stats (fetched once, joined client-side)
  const [usageMap, setUsageMap] = useState<Map<number, ChunkUsage>>(new Map());

  const load = useCallback(async (offset = 0, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      const res = await fetch(`/admin/api/knowledge?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setChunks(prev => (append ? [...prev, ...(data.chunks ?? [])] : data.chunks ?? []));
      setCounts(data.counts ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [kind, status, q]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Retrieval usage from the rerank decision log; non-fatal if it fails.
    fetch('/admin/api/knowledge/usage', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!data?.usage) return;
        setUsageMap(new Map((data.usage as ChunkUsage[]).map(u => [u.chunk_id, u])));
      })
      .catch(() => { /* badge-only data; ignore */ });
  }, []);

  // Workhorse = top decile by chosen_count among chunks that were ever chosen.
  const workhorseThreshold = useMemo(() => {
    const chosenCounts = [...usageMap.values()].map(u => u.chosen_count).filter(n => n > 0).sort((a, b) => a - b);
    if (chosenCounts.length === 0) return null;
    return chosenCounts[Math.min(chosenCounts.length - 1, Math.floor(chosenCounts.length * 0.9))];
  }, [usageMap]);

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
    const topicScope = approveTopic.trim();
    const scope = [kind || null, topicScope ? `topic "${topicScope}"` : null].filter(Boolean).join(' / ');
    if (!confirm(`Approve all pending${scope ? ` ${scope}` : ''} content? It becomes retrievable in live sessions.`)) return;
    const note = window.prompt('Approval note for this batch (optional — recorded in the audit trail):', '');
    if (note === null) return; // cancelled
    setBusy('bulk');
    try {
      const res = await fetch('/admin/api/knowledge/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...(kind ? { kind } : {}),
          ...(topicScope ? { topic: topicScope } : {}),
          ...(note ? { note } : {}),
        }),
      });
      if (!res.ok) throw new Error('approve failed');
      await load();
    } catch {
      setError('Bulk approve failed.');
    } finally {
      setBusy(null);
    }
  };

  const submitCreate = async (values: ChunkFormValues) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Create failed');
      setShowCreate(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = async (id: number, values: ChunkFormValues) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/admin/api/knowledge/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Update failed');
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const totalActive = counts.reduce((n, c) => n + c.active, 0);
  const totalPending = counts.reduce((n, c) => n + c.pending, 0);

  const tabs: { id: Tab; label: string; icon: typeof BookOpen }[] = [
    { id: 'content', label: 'Content', icon: BookOpen },
    { id: 'test', label: 'Test retrieval', icon: Target },
    { id: 'log', label: 'Retrieval log', icon: List },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-gray-900">Knowledge Base</h2>
        <p className="text-sm text-gray-600 mt-1">
          Curate the content the AI can retrieve (psychoeducation, worksheets, techniques).
          Only <strong>approved</strong> content is used in live sessions — approve items as they clear review.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === t.id ? 'border-royal text-royal' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'test' && <TestRetrievalPanel />}
      {tab === 'log' && <RetrievalLog />}

      {tab === 'content' && (
        <>
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
            <form
              onSubmit={e => { e.preventDefault(); setQ(searchInput.trim()); }}
              className="relative"
            >
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchInput}
                onChange={e => {
                  setSearchInput(e.target.value);
                  if (e.target.value === '') setQ('');
                }}
                placeholder="Search title, content, topic, source…"
                className="pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-72"
              />
            </form>
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
              onClick={() => { setShowCreate(v => !v); setEditingId(null); }}
              className="ml-auto px-4 py-2 bg-royal text-white rounded-lg text-sm font-medium hover:opacity-90 inline-flex items-center gap-2"
            >
              <Plus size={14} /> Add content
            </button>
          </div>

          {/* Bulk approve, scoped by the kind filter and an optional topic */}
          <div className="flex flex-wrap items-center gap-3 mb-4 p-3 bg-white rounded-lg shadow">
            <span className="text-xs text-gray-500">Bulk approve pending{kind ? ` (${kind})` : ''}:</span>
            <input
              type="text"
              value={approveTopic}
              onChange={e => setApproveTopic(e.target.value)}
              placeholder="topic scope (optional, e.g. anxiety)"
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs w-56"
            />
            <button
              onClick={approveAll}
              disabled={busy === 'bulk' || totalPending === 0}
              className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-40"
            >
              {busy === 'bulk' ? 'Approving…' : `Approve all pending${kind ? ` ${kind}` : ''}${approveTopic.trim() ? ` in "${approveTopic.trim()}"` : ''}`}
            </button>
          </div>

          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

          {showCreate && (
            <div className="mb-4">
              <ChunkForm
                mode="create"
                initial={EMPTY_FORM}
                saving={saving}
                onSubmit={submitCreate}
                onCancel={() => setShowCreate(false)}
              />
            </div>
          )}

          {loading && chunks.length === 0 ? (
            <div className="text-gray-500 p-8 text-center">Loading…</div>
          ) : chunks.length === 0 ? (
            <div className="text-gray-500 p-8 text-center bg-white rounded-lg shadow">No content matches this filter.</div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">Showing {chunks.length} of {total}</p>
              <div className="space-y-3">
                {chunks.map(c => (
                  editingId === c.chunk_id ? (
                    <ChunkForm
                      key={c.chunk_id}
                      mode="edit"
                      initial={formValuesFromChunk(c)}
                      saving={saving}
                      onSubmit={values => submitEdit(c.chunk_id, values)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <ChunkCard
                      key={c.chunk_id}
                      chunk={c}
                      usage={usageMap.get(c.chunk_id) ?? null}
                      workhorseThreshold={workhorseThreshold}
                      busy={busy === c.chunk_id}
                      onApprove={() => setActive(c.chunk_id, true)}
                      onUnapprove={() => setActive(c.chunk_id, false)}
                      onEdit={() => { setEditingId(c.chunk_id); setShowCreate(false); }}
                      onDelete={() => remove(c.chunk_id)}
                    />
                  )
                ))}
              </div>
              {chunks.length < total && (
                <div className="mt-4 text-center">
                  <button
                    onClick={() => load(chunks.length, true)}
                    disabled={loading}
                    className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {loading ? 'Loading…' : `Load more (${total - chunks.length} remaining)`}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
