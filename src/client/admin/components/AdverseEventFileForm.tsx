// Caseworker adverse-event filing form (caseworker portal spec s10 item 6).
// Files a draft AE report for a client on the member's caseload via
// POST /admin/api/clients/:userId/adverse-events; review and sign-off stay
// with the therapist/researcher review queue. Summaries tier by construction:
// the form carries only the reporter's own narrative — never transcript text.
import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'react-feather';

interface RosterClientLite {
  client_id: number;
  username: string;
}

interface RosterResponse {
  clients?: RosterClientLite[];
  members?: Array<{ clients: RosterClientLite[] }>;
}

interface AdverseEventFileFormProps {
  /** Preselect a client (e.g. opened from the roster/profile); otherwise the
   *  form loads the member's caseload for selection. */
  clientId?: number;
  clientName?: string;
  onClose: () => void;
  onFiled?: (reportId: number) => void;
}

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AdverseEventFileForm({ clientId, clientName, onClose, onFiled }: AdverseEventFileFormProps) {
  const [clients, setClients] = useState<RosterClientLite[]>([]);
  const [selectedClient, setSelectedClient] = useState<number | ''>(clientId ?? '');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high'>('medium');
  const [occurredAt, setOccurredAt] = useState(nowLocalInput());
  const [summary, setSummary] = useState('');
  const [actions, setActions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client picker: only needed when no client was preselected.
  useEffect(() => {
    if (clientId !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/admin/api/caseworker/roster', { credentials: 'include' });
        if (!res.ok) throw new Error(`roster load failed (${res.status})`);
        const data: RosterResponse = await res.json();
        const list = data.clients ?? data.members?.flatMap((m) => m.clients) ?? [];
        if (!cancelled) setClients(list);
      } catch {
        if (!cancelled) setError('Could not load your caseload.');
      }
    })();
    return () => { cancelled = true; };
  }, [clientId]);

  const submit = async () => {
    const target = clientId ?? selectedClient;
    if (target === '' || target === undefined) { setError('Select a client.'); return; }
    if (!summary.trim()) { setError('A summary of the event is required.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const actionLines = actions.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      const res = await fetch(`/admin/api/clients/${target}/adverse-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          summary: summary.trim(),
          severity,
          occurred_at: new Date(occurredAt).toISOString(),
          actions_taken: actionLines,
        }),
      });
      if (res.status === 404) throw new Error('Client not found on your caseload.');
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Filing failed (${res.status})`);
      }
      const report = await res.json();
      onFiled?.(report.report_id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Filing failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg bg-white rounded-lg shadow-xl p-6 max-h-full overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-600" /> Report adverse event
          </h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-800"><X size={20} /></button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Files a draft report for review and sign-off by the study team. Describe what happened in your own words — do not paste session content.
        </p>

        {clientId !== undefined ? (
          <p className="text-sm text-gray-700 mb-3"><span className="text-gray-500">Client:</span> {clientName ?? `user ${clientId}`}</p>
        ) : (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="ae-file-client">Client</label>
            <select
              id="ae-file-client"
              value={selectedClient}
              onChange={(e) => setSelectedClient(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3 bg-white"
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.client_id} value={c.client_id}>{c.username}</option>
              ))}
            </select>
          </>
        )}

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="ae-file-severity">Severity</label>
            <select
              id="ae-file-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as typeof severity)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="ae-file-occurred">When it occurred</label>
            <input
              id="ae-file-occurred"
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
        </div>

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="ae-file-summary">What happened</label>
        <textarea
          id="ae-file-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={4}
          placeholder="Describe the event, how you learned of it, and its impact on the participant."
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="ae-file-actions">Actions taken so far (optional, one per line)</label>
        <textarea
          id="ae-file-actions"
          value={actions}
          onChange={(e) => setActions(e.target.value)}
          rows={3}
          placeholder={'Called the client to check in\nNotified the treating therapist'}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3 font-mono"
        />

        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <button onClick={onClose} disabled={submitting} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-40">
            {submitting ? 'Filing…' : 'File report'}
          </button>
        </div>
      </div>
    </div>
  );
}
