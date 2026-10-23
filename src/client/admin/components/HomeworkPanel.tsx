// Homework panel on the participant profile (ai-therapist-200): the
// clinician half of practice_assignments. Lists every assignment (AI- and
// therapist-authored, all statuses) with the participant's completion note,
// and lets a therapist/researcher create, edit, cancel (with a reason) or
// re-issue one. Talks to /admin/api/clients/:userId/assignments; caseload
// and org scoping are enforced server-side (404), caseworkers never see it.
import { useState, type FormEvent } from 'react';
import { Plus, Edit2, XCircle, RefreshCw, Check } from 'react-feather';
import Panel from './ui/Panel';
import useAdminFetch from '../hooks/useAdminFetch';
import { requestJson, HttpError } from '../../shared/http';
import { formatDate } from '../../shared/format';
import {
  PRACTICE_FREQUENCIES,
  PRACTICE_KINDS,
  PRACTICE_TITLE_MAX,
  PRACTICE_DESCRIPTION_MAX,
  PRACTICE_CANCEL_REASON_MAX,
} from '../../../shared/practice';
import type { PracticeAssignmentListRow } from '../../../server/db/practiceAssignments.queries';

type Row = Omit<PracticeAssignmentListRow, 'assigned_at' | 'completed_at' | 'cancelled_at'> & {
  assigned_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
};

interface Draft {
  title: string;
  description: string;
  kind: (typeof PRACTICE_KINDS)[number];
  suggested_frequency: string;
}

const EMPTY_DRAFT: Draft = { title: '', description: '', kind: 'custom', suggested_frequency: '' };

const STATUS_TONE: Record<Row['status'], string> = {
  assigned: 'bg-blue-50 text-blue-700',
  completed: 'bg-green-50 text-green-700',
  skipped: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-50 text-red-700',
};

const inputClass = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-800';
const primaryBtn =
  'px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white';
const quietBtn = 'px-3 py-1.5 text-xs font-medium rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-50';

/** Create/edit form shared by the "New assignment" and inline edit flows. */
function AssignmentForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const valid = draft.title.trim().length > 0 && draft.description.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(draft);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <input
        type="text"
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        maxLength={PRACTICE_TITLE_MAX}
        placeholder="Title (e.g. Two-minute breathing before bed)"
        aria-label="Assignment title"
        className={inputClass}
      />
      <textarea
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        maxLength={PRACTICE_DESCRIPTION_MAX}
        rows={2}
        placeholder="What to actually do, in one or two sentences"
        aria-label="Assignment description"
        className={inputClass}
      />
      <div className="flex flex-wrap gap-2">
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}
          aria-label="Kind"
          className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 text-gray-800"
        >
          {PRACTICE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={draft.suggested_frequency}
          onChange={(e) => setDraft({ ...draft, suggested_frequency: e.target.value })}
          aria-label="Suggested frequency"
          className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 text-gray-800"
        >
          <option value="">No set frequency</option>
          {PRACTICE_FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button type="button" onClick={onCancel} disabled={busy} className={quietBtn}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !valid} className={primaryBtn}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export default function HomeworkPanel({ clientId }: { clientId: number }) {
  const base = `/admin/api/clients/${clientId}/assignments`;
  const list = useAdminFetch<{ assignments: Row[] }>(base);
  const [mode, setMode] = useState<
    { kind: 'idle' } | { kind: 'create' } | { kind: 'edit'; id: number } | { kind: 'cancel'; id: number }
  >({ kind: 'idle' });
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (url: string, method: 'POST' | 'PATCH', body?: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await requestJson(url, { method, body });
      list.refetch();
      setMode({ kind: 'idle' });
      setCancelReason('');
      return true;
    } catch (err: unknown) {
      setError(err instanceof HttpError ? err.message : 'Request failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toBody = (d: Draft) => ({
    title: d.title.trim(),
    description: d.description.trim(),
    kind: d.kind,
    suggested_frequency: d.suggested_frequency || null,
  });

  const rows = list.data?.assignments ?? [];

  return (
    <Panel>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-gray-600">
          Between-session practice, whether agreed in an AI conversation or set here. The participant sees open items on
          their home page and marks them done.
        </p>
        {mode.kind === 'idle' && (
          <button
            type="button"
            onClick={() => setMode({ kind: 'create' })}
            className={`${primaryBtn} flex items-center gap-1 flex-shrink-0`}
          >
            <Plus size={14} /> New
          </button>
        )}
      </div>

      {mode.kind === 'create' && (
        <div className="mb-4 p-3 rounded-lg bg-gray-50">
          <AssignmentForm
            initial={EMPTY_DRAFT}
            busy={busy}
            submitLabel="Assign"
            onSubmit={(d) => void call(base, 'POST', toBody(d))}
            onCancel={() => {
              setMode({ kind: 'idle' });
              setError(null);
            }}
          />
        </div>
      )}

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {list.loading ? (
        <p className="text-sm text-gray-400">Loading homework…</p>
      ) : list.error ? (
        <p className="text-sm text-gray-500">Could not load this participant&rsquo;s homework.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No practice has been assigned yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((a) => (
            <li key={a.id} className="py-3 space-y-2">
              {mode.kind === 'edit' && mode.id === a.id ? (
                <AssignmentForm
                  initial={{
                    title: a.title,
                    description: a.description,
                    kind: a.kind,
                    suggested_frequency: a.suggested_frequency ?? '',
                  }}
                  busy={busy}
                  submitLabel="Save"
                  onSubmit={(d) => void call(`${base}/${a.id}`, 'PATCH', toBody(d))}
                  onCancel={() => {
                    setMode({ kind: 'idle' });
                    setError(null);
                  }}
                />
              ) : (
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-800">{a.title}</p>
                      <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${STATUS_TONE[a.status]}`}>
                        {a.status}
                      </span>
                      <span className="text-xs text-gray-400">
                        {a.kind}
                        {a.suggested_frequency ? ` · ${a.suggested_frequency}` : ''}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">{a.description}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {a.source === 'therapist'
                        ? `Assigned by ${a.authored_by_username ?? 'clinician'}`
                        : 'Agreed in an AI conversation'}{' '}
                      {formatDate(a.assigned_at)}
                      {a.reissued_from !== null && <> · re-issue of #{a.reissued_from}</>}
                      {a.completed_at && <> · completed {formatDate(a.completed_at)}</>}
                      {a.cancelled_at && (
                        <>
                          {' '}
                          · cancelled {formatDate(a.cancelled_at)}
                          {a.cancelled_by_username ? ` by ${a.cancelled_by_username}` : ''}
                        </>
                      )}
                    </p>
                    {a.completion_note && (
                      <p className="text-xs text-gray-600 mt-1 flex items-start gap-1">
                        <Check size={12} className="text-green-600 mt-0.5 flex-shrink-0" />
                        <span>Participant note: {a.completion_note}</span>
                      </p>
                    )}
                    {a.cancel_reason && <p className="text-xs text-gray-500 mt-1">Cancel reason: {a.cancel_reason}</p>}
                  </div>
                  {mode.kind === 'idle' && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {a.status === 'assigned' ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setMode({ kind: 'edit', id: a.id })}
                            className={quietBtn}
                            aria-label={`Edit ${a.title}`}
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setMode({ kind: 'cancel', id: a.id })}
                            className={quietBtn}
                            aria-label={`Cancel ${a.title}`}
                          >
                            <XCircle size={14} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void call(`${base}/${a.id}/reissue`, 'POST')}
                          disabled={busy}
                          className={`${quietBtn} flex items-center gap-1`}
                        >
                          <RefreshCw size={14} /> Re-issue
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {mode.kind === 'cancel' && mode.id === a.id && (
                <div className="flex flex-wrap gap-2 items-center">
                  <input
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    maxLength={PRACTICE_CANCEL_REASON_MAX}
                    placeholder="Why is this being cancelled? (not shown to the participant)"
                    aria-label="Cancel reason"
                    className={`${inputClass} flex-1 min-w-[12rem]`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setMode({ kind: 'idle' });
                      setCancelReason('');
                      setError(null);
                    }}
                    disabled={busy}
                    className={quietBtn}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={() => void call(`${base}/${a.id}/cancel`, 'POST', { reason: cancelReason.trim() })}
                    disabled={busy || !cancelReason.trim()}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white"
                  >
                    {busy ? 'Cancelling…' : 'Cancel assignment'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
