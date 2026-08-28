// Admin view for IRB adverse-event reports (ai-therapist-95). Lists reports
// with overdue/due-soon reminders pinned on top, and a detail drawer to edit
// (draft only), sign off, reopen, close, and print/export a report.
// Caseworker mode (caseworker portal spec s10 item 6): the server filters the
// list to the member's own filed reports; the UI adds a "Report adverse
// event" filing form and renders the drawer read-only (review/sign-off stays
// therapist+researcher).
import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Clock, FileText, Plus, X, Printer } from 'react-feather';
import AdverseEventFileForm from './AdverseEventFileForm';
import { formatDateTime } from '../../shared/format';

interface TimelineEntry { at: string | null; kind: string; detail: string; }
interface ActionEntry { at: string | null; action: string; by: string | null; }

interface Report {
  report_id: number;
  session_ref: string;
  participant_ref: string | null;
  occurred_at: string;
  severity: 'low' | 'medium' | 'high';
  trigger_source: string;
  category: 'crisis' | 'eligibility_violation';
  summary: string;
  timeline: TimelineEntry[];
  transcript_excerpt: string | null;
  actions_taken: ActionEntry[];
  status: 'draft' | 'submitted' | 'closed';
  due_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  closed_by: string | null;
  overdue: boolean;
}

interface Counts { draft: number; submitted: number; overdue: number; due_soon: number; }

const STATUS_TABS = ['draft', 'submitted', 'closed', 'all'] as const;
type Tab = typeof STATUS_TABS[number];

const fmtDate = formatDateTime;

function dueRelative(due: string): { text: string; cls: string } {
  const ms = new Date(due).getTime() - Date.now();
  const hours = Math.round(ms / 3_600_000);
  if (ms < 0) return { text: `overdue by ${Math.abs(Math.round(hours / 24))}d`, cls: 'text-red-600 font-semibold' };
  if (hours <= 48) return { text: `due in ${hours}h`, cls: 'text-amber-600 font-semibold' };
  return { text: `due ${new Date(due).toLocaleDateString()}`, cls: 'text-gray-500' };
}

function CategoryBadge({ category }: { category: 'crisis' | 'eligibility_violation' }) {
  const isEligibility = category === 'eligibility_violation';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${isEligibility ? 'bg-purple-100 text-purple-700' : 'bg-red-100 text-red-700'}`}>
      {isEligibility ? 'Eligibility' : 'Crisis'}
    </span>
  );
}

interface AdverseEventsProps {
  /** Viewer role (from AdminApp). 'caseworker' switches to the slim filing
   *  mode; anything else keeps the full review surface. */
  role?: string | null;
}

export default function AdverseEvents({ role }: AdverseEventsProps = {}) {
  const isCaseworker = role === 'caseworker';
  const [reports, setReports] = useState<Report[]>([]);
  const [counts, setCounts] = useState<Counts>({ draft: 0, submitted: 0, overdue: 0, due_soon: 0 });
  const [tab, setTab] = useState<Tab>('draft');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Report | null>(null);
  const [saving, setSaving] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'crisis' | 'eligibility_violation'>('all');
  const [showFileForm, setShowFileForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/admin/api/adverse-events?status=${tab}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json();
      setReports(data.reports ?? []);
      setCounts(data.counts ?? { draft: 0, submitted: 0, overdue: 0, due_soon: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const refreshSelected = async (id: number) => {
    const res = await fetch(`/admin/api/adverse-events/${id}`, { credentials: 'include' });
    if (res.ok) setSelected(await res.json());
  };

  const saveDraft = async (summary: string, dueAt: string) => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/admin/api/adverse-events/${selected.report_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ summary, due_at: new Date(dueAt).toISOString() }),
      });
      if (!res.ok) throw new Error('save failed');
      setSelected(await res.json());
      await load();
    } catch {
      setError('Could not save the draft.');
    } finally {
      setSaving(false);
    }
  };

  const transition = async (id: number, action: 'submit' | 'reopen' | 'close') => {
    if (action === 'submit' && !confirm('Submit this report? The reporter identity and timestamp become the sign-off of record and edits are frozen.')) return;
    setSaving(true);
    try {
      const res = await fetch(`/admin/api/adverse-events/${id}/${action}`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('transition failed');
      setSelected(await res.json());
      await load();
    } catch {
      setError(`Could not ${action} the report.`);
    } finally {
      setSaving(false);
    }
  };

  const reminders = reports.filter(r => r.overdue || (r.status === 'draft' && new Date(r.due_at).getTime() - Date.now() <= 48 * 3600_000 && new Date(r.due_at).getTime() >= Date.now()));
  const visibleReports = categoryFilter === 'all' ? reports : reports.filter(r => r.category === categoryFilter);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Adverse Events</h2>
          <p className="text-sm text-gray-600 mt-1">
            {isCaseworker
              ? 'Reports you have filed for clients on your caseload. Review and sign-off are handled by the study team.'
              : 'IRB adverse-event reports auto-drafted from high-severity crisis flags. Review, sign off, and export.'}
          </p>
        </div>
        {isCaseworker && (
          <button
            onClick={() => setShowFileForm(true)}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 inline-flex items-center gap-1"
          >
            <Plus size={14} /> Report adverse event
          </button>
        )}
      </div>

      {/* Counts strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-lg shadow p-4"><p className="text-xs text-gray-500">Drafts</p><p className="text-2xl font-bold text-gray-900">{counts.draft}</p></div>
        <div className="bg-white rounded-lg shadow p-4"><p className="text-xs text-gray-500">Submitted</p><p className="text-2xl font-bold text-blue-600">{counts.submitted}</p></div>
        <div className="bg-white rounded-lg shadow p-4"><p className="text-xs text-gray-500">Overdue</p><p className="text-2xl font-bold text-red-600">{counts.overdue}</p></div>
        <div className="bg-white rounded-lg shadow p-4"><p className="text-xs text-gray-500">Due soon (48h)</p><p className="text-2xl font-bold text-amber-600">{counts.due_soon}</p></div>
      </div>

      {/* Reminder row pinned on top */}
      {reminders.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle size={16} />
          {reminders.length} draft{reminders.length === 1 ? '' : 's'} overdue or due within 48h{isCaseworker ? ' — awaiting study-team review.' : ' — please review and sign off.'}
        </div>
      )}

      {/* Status tabs + category filter */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {STATUS_TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize ${tab === t ? 'bg-royal text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'}`}
          >
            {t}
          </button>
        ))}
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value as typeof categoryFilter)}
          className="ml-auto px-3 py-1.5 rounded-lg text-sm border border-gray-300 bg-white text-gray-700"
          aria-label="Filter by category"
        >
          <option value="all">All types</option>
          <option value="crisis">Crisis</option>
          <option value="eligibility_violation">Eligibility</option>
        </select>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-gray-500 p-8 text-center">Loading…</div>
      ) : visibleReports.length === 0 ? (
        <div className="text-gray-500 p-8 text-center bg-white rounded-lg shadow">No reports in this view.</div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {['ID', 'Session', 'Type', 'Severity', 'Occurred', 'Due', 'Status', 'Reporter'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {visibleReports.map(r => {
                const due = dueRelative(r.due_at);
                return (
                  <tr key={r.report_id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(r)}>
                    <td className="px-4 py-3 text-sm text-gray-900">#{r.report_id}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 font-mono truncate max-w-[10rem]">{r.session_ref}</td>
                    <td className="px-4 py-3 text-sm"><CategoryBadge category={r.category} /></td>
                    <td className="px-4 py-3 text-sm capitalize">{r.severity}</td>
                    <td className="px-4 py-3 text-sm text-gray-500">{fmtDate(r.occurred_at)}</td>
                    <td className={`px-4 py-3 text-sm ${due.cls}`}>{due.text}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${r.status === 'draft' ? 'bg-amber-100 text-amber-700' : r.status === 'submitted' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{r.status}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{r.submitted_by ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <DetailDrawer
          report={selected}
          saving={saving}
          readOnly={isCaseworker}
          onClose={() => setSelected(null)}
          onSave={saveDraft}
          onTransition={transition}
          onRefresh={() => refreshSelected(selected.report_id)}
        />
      )}

      {showFileForm && (
        <AdverseEventFileForm
          onClose={() => setShowFileForm(false)}
          onFiled={() => { setShowFileForm(false); load(); }}
        />
      )}
    </div>
  );
}

interface DrawerProps {
  report: Report;
  saving: boolean;
  /** Caseworker mode: view own filed report only — no edits, transitions, or
   *  print (those endpoints are therapist/researcher). */
  readOnly?: boolean;
  onClose: () => void;
  onSave: (summary: string, dueAt: string) => void;
  onTransition: (id: number, action: 'submit' | 'reopen' | 'close') => void;
  onRefresh: () => void;
}

function toLocalInput(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function DetailDrawer({ report, saving, readOnly = false, onClose, onSave, onTransition }: DrawerProps) {
  const [summary, setSummary] = useState(report.summary);
  const [dueAt, setDueAt] = useState(toLocalInput(report.due_at));
  const isDraft = report.status === 'draft' && !readOnly;

  useEffect(() => {
    setSummary(report.summary);
    setDueAt(toLocalInput(report.due_at));
  }, [report]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-2xl bg-white h-full overflow-y-auto shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-900">Adverse Event #{report.report_id}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-800"><X size={22} /></button>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-4">
          <div><span className="text-gray-500">Participant:</span> {report.participant_ref ?? '—'}</div>
          <div><span className="text-gray-500">Session:</span> <span className="font-mono">{report.session_ref}</span></div>
          <div><span className="text-gray-500">Severity:</span> <span className="capitalize">{report.severity}</span></div>
          <div><span className="text-gray-500">Type:</span> <CategoryBadge category={report.category} /></div>
          <div><span className="text-gray-500">Trigger:</span> {report.trigger_source}</div>
          <div><span className="text-gray-500">Occurred:</span> {fmtDate(report.occurred_at)}</div>
          <div><span className="text-gray-500">Status:</span> <span className="capitalize">{report.status}</span></div>
          {report.submitted_by && <div className="col-span-2"><span className="text-gray-500">Signed off by:</span> {report.submitted_by} @ {fmtDate(report.submitted_at)}</div>}
        </div>

        <label className="block text-sm font-medium text-gray-700 mb-1">Summary</label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          disabled={!isDraft}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3 disabled:bg-gray-50 disabled:text-gray-500"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1">Reporting deadline</label>
        <input
          type="datetime-local"
          value={dueAt}
          onChange={e => setDueAt(e.target.value)}
          disabled={!isDraft}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm mb-4 disabled:bg-gray-50 disabled:text-gray-500"
        />

        <h4 className="text-sm font-semibold text-gray-800 mt-2 mb-1 flex items-center gap-1"><Clock size={14} /> Timeline</h4>
        <div className="border border-gray-200 rounded mb-4 overflow-hidden">
          <table className="min-w-full text-xs">
            <tbody className="divide-y divide-gray-100">
              {report.timeline.length === 0 ? (
                <tr><td className="px-3 py-2 text-gray-400">No timeline entries.</td></tr>
              ) : report.timeline.map((t, i) => (
                <tr key={i}><td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{fmtDate(t.at)}</td><td className="px-3 py-1.5 text-gray-600">{t.kind}</td><td className="px-3 py-1.5 text-gray-800">{t.detail}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4 className="text-sm font-semibold text-gray-800 mb-1">Actions taken</h4>
        <div className="border border-gray-200 rounded mb-4 overflow-hidden">
          <table className="min-w-full text-xs">
            <tbody className="divide-y divide-gray-100">
              {report.actions_taken.length === 0 ? (
                <tr><td className="px-3 py-2 text-gray-400">No actions recorded.</td></tr>
              ) : report.actions_taken.map((a, i) => (
                <tr key={i}><td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{fmtDate(a.at)}</td><td className="px-3 py-1.5 text-gray-800">{a.action}</td><td className="px-3 py-1.5 text-gray-600">{a.by ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        {!readOnly && (
          <>
            <h4 className="text-sm font-semibold text-gray-800 mb-1">Transcript excerpt (redacted)</h4>
            <pre className="p-3 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 whitespace-pre-wrap mb-4 max-h-48 overflow-y-auto">{report.transcript_excerpt || 'No excerpt captured.'}</pre>
          </>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
          {isDraft && (
            <>
              <button onClick={() => onSave(summary, dueAt)} disabled={saving} className="px-4 py-2 bg-royal text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 inline-flex items-center gap-1"><FileText size={14} /> Save</button>
              <button onClick={() => onTransition(report.report_id, 'submit')} disabled={saving} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-40">Submit (sign off)</button>
            </>
          )}
          {report.status === 'submitted' && !readOnly && (
            <>
              <button onClick={() => onTransition(report.report_id, 'reopen')} disabled={saving} className="px-4 py-2 border border-amber-300 text-amber-700 rounded-lg text-sm font-medium hover:bg-amber-50 disabled:opacity-40">Reopen</button>
              <button onClick={() => onTransition(report.report_id, 'close')} disabled={saving} className="px-4 py-2 bg-gray-700 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-40">Close</button>
            </>
          )}
          {readOnly ? (
            <span className="text-xs text-gray-500 py-2">Read-only: review, sign-off, and export are handled by the study team.</span>
          ) : (
            <a href={`/admin/api/adverse-events/${report.report_id}/print`} target="_blank" rel="noreferrer" className="ml-auto px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 inline-flex items-center gap-1"><Printer size={14} /> Print / Export PDF</a>
          )}
        </div>
      </div>
    </div>
  );
}
