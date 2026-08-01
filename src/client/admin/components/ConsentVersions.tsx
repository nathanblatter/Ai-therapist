// Admin view for versioned IRB consent copy (ai-therapist-94). Researchers can
// review every published version (with acceptance counts) and publish a new one.
// Publishing with an immediate effective date re-consents every participant.
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, Clock, ChevronDown, ChevronUp } from 'react-feather';
import { toast } from '../../shared/components/Toast';

interface Version {
  document_id: number;
  version: string;
  body: string;
  body_hash: string;
  effective_at: string;
  published_by: string;
  created_at: string;
  acceptance_count: number;
}

function suggestVersion(): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${iso}.1`;
}

export default function ConsentVersions() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [newVersion, setNewVersion] = useState('');
  const [newBody, setNewBody] = useState('');
  const [effectiveAt, setEffectiveAt] = useState('');
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/consent/versions', { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setVersions(data.versions ?? []);
      setActiveVersion(data.activeVersion ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openForm = () => {
    // Prefill the version suggestion and the active body (for editing).
    setNewVersion(suggestVersion());
    const active = versions.find(v => v.version === activeVersion);
    setNewBody(active?.body ?? '');
    setEffectiveAt('');
    setShowForm(true);
  };

  const publish = async () => {
    if (!newVersion.trim() || !newBody.trim()) {
      setError('Version and body are required.');
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/consent/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          version: newVersion.trim(),
          body: newBody,
          ...(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Publish failed (${res.status})`);
      }
      toast.success('Consent version published.');
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Consent Versions</h2>
          <p className="text-sm text-gray-600 mt-1">
            The versioned IRB consent copy participants accept. The active version is the newest one
            whose effective date has passed. Each acceptance is stored with a hash of the exact text.
          </p>
        </div>
        <button
          onClick={openForm}
          className="shrink-0 px-4 py-2 bg-royal text-white rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          Publish new version
        </button>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {showForm && (
        <div className="mb-6 bg-white rounded-lg shadow p-5 space-y-4">
          <h3 className="font-semibold text-gray-900">Publish new consent version</h3>
          <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
            Publishing immediately blocks all participants from starting sessions until they re-accept.
            Set a future effective date to schedule instead.
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Version</label>
            <input
              value={newVersion}
              onChange={e => setNewVersion(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              placeholder="YYYY-MM-DD.1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Body (markdown)</label>
            <textarea
              value={newBody}
              onChange={e => setNewBody(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
              placeholder="## Before we begin&#10;&#10;- **Disclosure.** ..."
            />
            <p className="text-xs text-gray-400 mt-1">
              The recording-disclosure bullet is added automatically when session recording is enabled — do not include it here.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Effective at (optional — defaults to now)</label>
            <input
              type="datetime-local"
              value={effectiveAt}
              onChange={e => setEffectiveAt(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800" disabled={publishing}>
              Cancel
            </button>
            <button onClick={publish} disabled={publishing} className="px-4 py-2 bg-royal text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
              {publishing ? 'Publishing…' : 'Publish version'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-gray-500 p-8 text-center">Loading…</div>
      ) : versions.length === 0 ? (
        <div className="text-gray-500 p-8 text-center bg-white rounded-lg shadow">No consent versions yet.</div>
      ) : (
        <div className="space-y-3">
          {versions.map(v => {
            const isActive = v.version === activeVersion;
            const scheduled = new Date(v.effective_at).getTime() > Date.now();
            return (
              <div key={v.document_id} className="bg-white rounded-lg shadow p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{v.version}</span>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
                        <CheckCircle size={12} /> Active
                      </span>
                    )}
                    {scheduled && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                        <Clock size={12} /> Scheduled
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setExpanded(expanded === v.document_id ? null : v.document_id)}
                    className="text-sm text-royal inline-flex items-center gap-1 hover:underline"
                  >
                    {expanded === v.document_id ? <>Hide <ChevronUp size={14} /></> : <>Preview <ChevronDown size={14} /></>}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Effective {new Date(v.effective_at).toLocaleString()} · published by {v.published_by} · {v.acceptance_count} acceptance{v.acceptance_count === 1 ? '' : 's'}
                </p>
                {expanded === v.document_id && (
                  <pre className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 whitespace-pre-wrap font-mono overflow-x-auto">{v.body}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
