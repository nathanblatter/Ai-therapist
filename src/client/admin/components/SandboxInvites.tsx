// Researcher view for minting sandbox invite batches (caseworker portal,
// spec section 7): mint 1-500 one-time /join-sandbox links for a role, see
// the raw links exactly once (with a client-side CSV download), and review
// batch history with used/total counts. Raw tokens are never retrievable
// after the mint response.
import { useState, useEffect, useCallback } from 'react';
import { Box, Copy, Download, RefreshCw } from 'react-feather';
import Panel from './ui/Panel';
import { toast } from '../../shared/components/Toast';

interface MintedLink {
  inviteId: number;
  link: string;
}

interface MintResult {
  batchId: string;
  role: string;
  label: string | null;
  expiresAt: string | null;
  links: MintedLink[];
}

interface BatchRow {
  batch_id: string;
  invite_role: string;
  seed_profile: string;
  label: string | null;
  created_by: number;
  created_at: string;
  expires_at: string;
  total: number;
  used: number;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export default function SandboxInvites() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [count, setCount] = useState('10');
  const [role, setRole] = useState<'therapist' | 'caseworker'>('therapist');
  const [label, setLabel] = useState('');
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/sandbox/invites', { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setBatches(data.batches ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const mint = async () => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      setError('Count must be a whole number between 1 and 500.');
      return;
    }
    setMinting(true);
    setError(null);
    try {
      const res = await fetch('/admin/api/sandbox/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ count: n, role, ...(label.trim() ? { label: label.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Mint failed (${res.status})`);
      setMinted(data as MintResult);
      toast.success(`Minted ${data.links.length} sandbox link${data.links.length === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed');
    } finally {
      setMinting(false);
    }
  };

  const fullUrl = (link: string) => `${window.location.origin}${link}`;

  const downloadCsv = () => {
    if (!minted) return;
    const rows = [
      'invite_id,role,label,link',
      ...minted.links.map((l) =>
        [String(l.inviteId), minted.role, csvEscape(minted.label ?? ''), fullUrl(l.link)].join(',')
      ),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sandbox-invites-${minted.batchId.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyAll = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.links.map((l) => fullUrl(l.link)).join('\n'));
      toast.success('All links copied.');
    } catch {
      toast.error('Copy failed.');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Sandbox Invites</h2>
        <p className="text-sm text-gray-600 mt-1">
          One-time links that create an isolated, pre-seeded demo environment (a fresh sandbox
          organization with 6-9 synthetic clients) for a therapist or caseworker. Sandbox data never
          reaches research exports, crisis paging, or email.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <Panel title="Mint a batch" icon={Box}>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="sbx-count">Count</label>
            <input
              id="sbx-count"
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              className="w-24 px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="sbx-role">Dashboard role</label>
            <select
              id="sbx-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'therapist' | 'caseworker')}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="therapist">Therapist</option>
              <option value="caseworker">Caseworker</option>
            </select>
          </div>
          <div className="flex-1 min-w-[12rem]">
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="sbx-label">Batch label (optional)</label>
            <input
              id="sbx-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. conference demo wave"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <button
            onClick={mint}
            disabled={minting}
            className="px-4 py-2 bg-royal text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
          >
            {minting ? 'Minting…' : 'Mint links'}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Links expire after 30 days if unused. Each link can be used exactly once.
        </p>
      </Panel>

      {minted && (
        <Panel title={`New links — shown once (${minted.links.length})`}>
          <div className="mb-3 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
            These raw links cannot be retrieved again. Download the CSV or copy them now.
          </div>
          <div className="flex gap-2 mb-3">
            <button
              onClick={downloadCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm hover:bg-gray-700"
            >
              <Download size={14} /> Download CSV
            </button>
            <button
              onClick={copyAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
            >
              <Copy size={14} /> Copy all
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-md">
            <table className="w-full text-sm">
              <tbody>
                {minted.links.map((l) => (
                  <tr key={l.inviteId} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-1.5 text-gray-400 w-12">{l.inviteId}</td>
                    <td className="px-3 py-1.5 font-mono text-xs break-all">{fullUrl(l.link)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Batch history">
        <div className="flex justify-end mb-2">
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        {loading ? (
          <div className="text-gray-500 py-6 text-center">Loading…</div>
        ) : batches.length === 0 ? (
          <div className="text-gray-500 py-6 text-center">No sandbox invite batches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase border-b border-gray-200">
                  <th className="py-2 pr-4">Label</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Expires</th>
                  <th className="py-2 pr-4">Used</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.batch_id} className="border-b border-gray-100 last:border-0">
                    <td className="py-2 pr-4 text-gray-900">{b.label ?? <span className="text-gray-400">(no label)</span>}</td>
                    <td className="py-2 pr-4 capitalize">{b.invite_role}</td>
                    <td className="py-2 pr-4 text-gray-500">{new Date(b.created_at).toLocaleDateString()}</td>
                    <td className="py-2 pr-4 text-gray-500">{new Date(b.expires_at).toLocaleDateString()}</td>
                    <td className="py-2 pr-4">
                      <span className={b.used === b.total ? 'text-emerald-700' : 'text-gray-700'}>
                        {b.used} / {b.total}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
