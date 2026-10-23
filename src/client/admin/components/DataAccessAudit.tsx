// Data Access view (ai-therapist-197): the read side of the append-only
// accountability tables the IRB was told exist. Researcher-only. One table
// shell, five tabs:
//   Data access      data_access_log   (filters + pagination + participant drill-in)
//   Redaction review redaction_review_log
//   Assistant        assistant_audit
//   Caseload changes caseload_audit_log      (existing GET /admin/api/caseload/audit)
//   Content wipes    content_wipe_log        (existing GET /admin/api/content-retention/log)
import { useState, type ReactNode } from 'react';
import { Eye, ArrowLeft, Filter } from 'react-feather';
import Panel from './ui/Panel';
import useAdminFetch from '../hooks/useAdminFetch';
import ParticipantAccessHistory, { actionLabel, detailSummary, TH, TD } from './ParticipantAccessHistory';
import { formatDateTime } from '../../shared/format';
import type { DataAccessLogRow } from '../../../server/db/accessLog.queries';
import type { RedactionReviewLogRow } from '../../../server/db/redaction.queries';
import type { AssistantAuditRow } from '../../../server/db/assistantAudit.queries';
import type { CaseloadAuditRow } from '../../../server/db/caseload.queries';

type Tab = 'data-access' | 'redaction-review' | 'assistant' | 'caseload' | 'wipes';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'data-access', label: 'Data access' },
  { id: 'redaction-review', label: 'Redaction review' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'caseload', label: 'Caseload changes' },
  { id: 'wipes', label: 'Content wipes' },
];

const PAGE_SIZE = 50;
const ACTIONS = [
  'transcript_view',
  'recording_stream',
  'recording_download',
  'export',
  'dataset_export',
  'audit_log_view',
  'worksheet_review',
];

interface Column<Row> {
  key: string;
  label: string;
  className?: string;
  render: (row: Row) => ReactNode;
}

/** The one table shell every tab renders through. */
function AuditTable<Row>({
  columns,
  rows,
  rowKey,
  emptyText,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string | number;
  emptyText: string;
}) {
  if (rows.length === 0) return <p className="text-gray-500 text-center py-8">{emptyText}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200" role="table">
        <thead className="bg-gray-50">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`${TH} ${c.className ?? ''}`} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={`${TD} ${c.className ?? ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pager({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  const end = Math.min(offset + PAGE_SIZE, total);
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-sm text-gray-500">{total === 0 ? 'No rows' : `${offset + 1}–${end} of ${total}`}</p>
      <div className="flex gap-2">
        <button
          onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-50 min-h-[36px]"
        >
          Previous
        </button>
        <button
          onClick={() => onChange(offset + PAGE_SIZE)}
          disabled={end >= total}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded disabled:opacity-50 min-h-[36px]"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function Status({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <p className="text-red-600 text-center py-8">{error}</p>;
  if (loading) return <p className="text-gray-500 text-center py-8">Loading…</p>;
  return null;
}

const INPUT = 'border border-gray-300 rounded px-2 py-1.5 text-sm min-h-[36px]';

function Actor({ username, id, role }: { username: string | null; id: number | null; role?: string | null }) {
  return (
    <>
      <span className="font-medium text-gray-900">{username ?? (id !== null ? `user #${id}` : 'unknown')}</span>
      {role && <span className="text-xs text-gray-500 ml-1">({role})</span>}
    </>
  );
}

// ---------------------------------------------------------------- tabs ----

interface DataAccessFilters {
  participantUserId: string;
  actorUsername: string;
  action: string;
  since: string;
  until: string;
}
const EMPTY_FILTERS: DataAccessFilters = { participantUserId: '', actorUsername: '', action: '', since: '', until: '' };

function DataAccessTab({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [draft, setDraft] = useState<DataAccessFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<DataAccessFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [drillIn, setDrillIn] = useState<{ userId: number; username: string | null } | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (applied.participantUserId) params.set('participantUserId', applied.participantUserId);
  if (applied.actorUsername) params.set('actorUsername', applied.actorUsername);
  if (applied.action) params.set('action', applied.action);
  if (applied.since) params.set('since', applied.since);
  // The date input yields a day; make `until` exclusive of the following midnight.
  if (applied.until) {
    const d = new Date(applied.until);
    d.setDate(d.getDate() + 1);
    params.set('until', d.toISOString().slice(0, 10));
  }
  const { data, loading, error } = useAdminFetch<{ rows: DataAccessLogRow[]; total: number }>(
    `/admin/api/audit/data-access?${params}`,
  );

  if (drillIn) {
    return (
      <Panel>
        <button
          onClick={() => setDrillIn(null)}
          className="text-sm text-royal hover:underline flex items-center gap-1 mb-4"
        >
          <ArrowLeft size={14} /> Back to the full log
        </button>
        <h4 className="text-lg font-semibold mb-4">
          Access history for {drillIn.username ?? `user #${drillIn.userId}`}
        </h4>
        <ParticipantAccessHistory userId={drillIn.userId} onViewSession={onViewSession} />
      </Panel>
    );
  }

  const apply = () => {
    setApplied(draft);
    setOffset(0);
  };
  const clear = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setOffset(0);
  };

  const columns: Column<DataAccessLogRow>[] = [
    { key: 'when', label: 'When', className: 'whitespace-nowrap', render: (r) => formatDateTime(r.created_at) },
    { key: 'who', label: 'Who', render: (r) => <Actor username={r.actor_username} id={r.accessed_by} role={r.role} /> },
    { key: 'action', label: 'Action', render: (r) => actionLabel(r.action, r.detail) },
    {
      key: 'participant',
      label: 'Participant',
      render: (r) =>
        r.participant_user_id !== null ? (
          <button
            onClick={() => setDrillIn({ userId: r.participant_user_id!, username: r.participant_username })}
            className="text-royal hover:underline"
            title="Open this participant's access history"
          >
            {r.participant_username ?? `user #${r.participant_user_id}`}
          </button>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: 'session',
      label: 'Session',
      className: 'font-mono text-xs',
      render: (r) =>
        r.session_id ? (
          onViewSession ? (
            <button onClick={() => onViewSession(r.session_id!)} className="text-royal hover:underline">
              {r.session_id.slice(0, 8)}…
            </button>
          ) : (
            <span title={r.session_id}>{r.session_id.slice(0, 8)}…</span>
          )
        ) : (
          '—'
        ),
    },
    {
      key: 'detail',
      label: 'Detail',
      className: 'text-xs text-gray-500',
      render: (r) => detailSummary(r.detail) || '—',
    },
  ];

  return (
    <Panel>
      <form
        className="flex flex-wrap items-end gap-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        aria-label="Filter the data access log"
      >
        <label className="text-xs text-gray-600 flex flex-col gap-1">
          Participant user id
          <input
            className={INPUT}
            inputMode="numeric"
            value={draft.participantUserId}
            onChange={(e) => setDraft({ ...draft, participantUserId: e.target.value })}
            placeholder="e.g. 42"
          />
        </label>
        <label className="text-xs text-gray-600 flex flex-col gap-1">
          Actor username
          <input
            className={INPUT}
            value={draft.actorUsername}
            onChange={(e) => setDraft({ ...draft, actorUsername: e.target.value })}
            placeholder="contains…"
          />
        </label>
        <label className="text-xs text-gray-600 flex flex-col gap-1">
          Action
          <select
            className={INPUT}
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          >
            <option value="">Any</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-600 flex flex-col gap-1">
          From
          <input
            type="date"
            className={INPUT}
            value={draft.since}
            onChange={(e) => setDraft({ ...draft, since: e.target.value })}
          />
        </label>
        <label className="text-xs text-gray-600 flex flex-col gap-1">
          To
          <input
            type="date"
            className={INPUT}
            value={draft.until}
            onChange={(e) => setDraft({ ...draft, until: e.target.value })}
          />
        </label>
        <button
          type="submit"
          className="px-3 py-1.5 bg-royal text-white rounded hover:bg-navy transition text-sm min-h-[36px] flex items-center gap-1"
        >
          <Filter size={14} /> Apply
        </button>
        <button
          type="button"
          onClick={clear}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded min-h-[36px]"
        >
          Clear
        </button>
      </form>

      <Status loading={loading && !data} error={error} />
      {data && (
        <>
          <AuditTable
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.id}
            emptyText="No data access matches these filters."
          />
          <Pager offset={offset} total={data.total} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}

function RedactionReviewTab({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (action) params.set('action', action);
  const { data, loading, error } = useAdminFetch<{ rows: RedactionReviewLogRow[]; total: number }>(
    `/admin/api/audit/redaction-review?${params}`,
  );
  const columns: Column<RedactionReviewLogRow>[] = [
    { key: 'when', label: 'When', className: 'whitespace-nowrap', render: (r) => formatDateTime(r.created_at) },
    { key: 'who', label: 'Reviewer', render: (r) => <Actor username={r.reviewer_username} id={r.reviewed_by} /> },
    {
      key: 'action',
      label: 'Outcome',
      render: (r) => (
        <span
          className={`text-xs px-2 py-0.5 rounded ${r.action === 'corrected' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}
        >
          {r.action}
        </span>
      ),
    },
    { key: 'message', label: 'Message id', className: 'font-mono text-xs', render: (r) => r.message_id },
    {
      key: 'session',
      label: 'Session',
      className: 'font-mono text-xs',
      render: (r) =>
        r.session_id ? (
          onViewSession ? (
            <button onClick={() => onViewSession(r.session_id!)} className="text-royal hover:underline">
              {r.session_id.slice(0, 8)}…
            </button>
          ) : (
            <span title={r.session_id}>{r.session_id.slice(0, 8)}…</span>
          )
        ) : (
          <span className="text-gray-400" title="Message no longer exists">
            —
          </span>
        ),
    },
    { key: 'participant', label: 'Participant id', render: (r) => r.participant_user_id ?? '—' },
  ];
  return (
    <Panel>
      <div className="flex items-center gap-3 mb-4">
        <label className="text-xs text-gray-600 flex items-center gap-2">
          Outcome
          <select
            className={INPUT}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">Any</option>
            <option value="approved">approved</option>
            <option value="corrected">corrected</option>
          </select>
        </label>
      </div>
      <Status loading={loading && !data} error={error} />
      {data && (
        <>
          <AuditTable
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.review_id}
            emptyText="No redaction reviews recorded yet."
          />
          <Pager offset={offset} total={data.total} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}

function AssistantTab() {
  const [offset, setOffset] = useState(0);
  const [username, setUsername] = useState('');
  const [applied, setApplied] = useState('');
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (applied) params.set('username', applied);
  const { data, loading, error } = useAdminFetch<{ rows: AssistantAuditRow[]; total: number }>(
    `/admin/api/audit/assistant?${params}`,
  );
  const columns: Column<AssistantAuditRow>[] = [
    { key: 'when', label: 'When', className: 'whitespace-nowrap', render: (r) => formatDateTime(r.created_at) },
    { key: 'who', label: 'Who', render: (r) => <Actor username={r.username} id={r.user_id} role={r.role} /> },
    {
      key: 'question',
      label: 'Question',
      className: 'max-w-md',
      render: (r) => (
        <span className="line-clamp-2" title={r.question}>
          {r.question}
        </span>
      ),
    },
    {
      key: 'tools',
      label: 'Tools run (rows returned)',
      className: 'text-xs',
      render: (r) =>
        r.tools.length === 0 ? (
          <span className="text-gray-400">none</span>
        ) : (
          <ul className="space-y-0.5">
            {r.tools.map((t, i) => (
              <li key={i} className="font-mono">
                {t.name} ({t.row_count})
              </li>
            ))}
          </ul>
        ),
    },
    { key: 'model', label: 'Model', className: 'text-xs', render: (r) => r.model },
    {
      key: 'tokens',
      label: 'Tokens in / out',
      className: 'text-xs tabular-nums whitespace-nowrap',
      render: (r) => `${r.input_tokens ?? '—'} / ${r.output_tokens ?? '—'}`,
    },
  ];
  return (
    <Panel>
      <form
        className="flex items-end gap-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(username);
          setOffset(0);
        }}
      >
        <label className="text-xs text-gray-600 flex flex-col gap-1">
          Asked by (username)
          <input
            className={INPUT}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="contains…"
          />
        </label>
        <button
          type="submit"
          className="px-3 py-1.5 bg-royal text-white rounded hover:bg-navy transition text-sm min-h-[36px]"
        >
          Apply
        </button>
      </form>
      <Status loading={loading && !data} error={error} />
      {data && (
        <>
          <AuditTable
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.audit_id}
            emptyText="No assistant turns recorded yet."
          />
          <Pager offset={offset} total={data.total} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}

function CaseloadTab() {
  const { data, loading, error } = useAdminFetch<{ audit: CaseloadAuditRow[] }>('/admin/api/caseload/audit');
  const columns: Column<CaseloadAuditRow>[] = [
    { key: 'when', label: 'When', className: 'whitespace-nowrap', render: (r) => formatDateTime(r.created_at) },
    { key: 'who', label: 'Actor', render: (r) => <Actor username={r.actor_username} id={r.actor_user_id} /> },
    { key: 'action', label: 'Action', render: (r) => r.action.replace(/_/g, ' ') },
    { key: 'member', label: 'Care-team member id', render: (r) => r.therapist_id ?? '—' },
    { key: 'client', label: 'Client id', render: (r) => r.client_id ?? '—' },
    {
      key: 'detail',
      label: 'Detail',
      className: 'text-xs text-gray-500',
      render: (r) => detailSummary(r.detail) || '—',
    },
  ];
  return (
    <Panel>
      <p className="text-sm text-gray-500 mb-4">
        Assignments, invites, work-queue actions and adverse-event filings. Most recent 200 rows.
      </p>
      <Status loading={loading && !data} error={error} />
      {data && (
        <AuditTable
          columns={columns}
          rows={data.audit}
          rowKey={(r) => r.audit_id}
          emptyText="No caseload changes recorded yet."
        />
      )}
    </Panel>
  );
}

type WipeRow = Record<string, unknown>;
function WipesTab() {
  const [offset, setOffset] = useState(0);
  const { data, loading, error } = useAdminFetch<{ wipes: WipeRow[]; total: number }>(
    `/admin/api/content-retention/log?limit=${PAGE_SIZE}&offset=${offset}`,
  );
  const str = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
  const columns: Column<WipeRow>[] = [
    {
      key: 'started',
      label: 'Started',
      className: 'whitespace-nowrap',
      render: (r) => formatDateTime(r.started_at as string),
    },
    {
      key: 'completed',
      label: 'Completed',
      className: 'whitespace-nowrap',
      render: (r) => formatDateTime(r.completed_at as string | null),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <span
          className={`text-xs px-2 py-0.5 rounded ${r.status === 'failed' ? 'bg-red-100 text-red-800' : r.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}
        >
          {str(r.status)}
        </span>
      ),
    },
    {
      key: 'trigger',
      label: 'Triggered by',
      render: (r) => `${str(r.triggered_by)}${r.triggered_by_user ? ` (${String(r.triggered_by_user)})` : ''}`,
    },
    { key: 'wiped', label: 'Wiped', className: 'text-right tabular-nums', render: (r) => str(r.messages_wiped) },
    { key: 'skipped', label: 'Skipped', className: 'text-right tabular-nums', render: (r) => str(r.messages_skipped) },
    {
      key: 'retention',
      label: 'Retention (h)',
      className: 'text-right tabular-nums',
      render: (r) => str(r.retention_hours),
    },
    { key: 'error', label: 'Error', className: 'text-xs text-red-700', render: (r) => str(r.error_message) },
  ];
  return (
    <Panel>
      <Status loading={loading && !data} error={error} />
      {data && (
        <>
          <AuditTable
            columns={columns}
            rows={data.wipes}
            rowKey={(r) => String(r.wipe_id)}
            emptyText="No content wipes recorded yet."
          />
          <Pager offset={offset} total={data.total} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- view ----

export default function DataAccessAudit({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const [tab, setTab] = useState<Tab>('data-access');
  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Eye size={24} /> Data Access
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Who has seen participant data: every transcript view, recording playback and export, plus the
          redaction-review, assistant, caseload and content-wipe trails. Append-only; rows outlive account deletion.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-gray-200" role="tablist" aria-label="Audit trails">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition min-h-[40px] ${
              tab === t.id ? 'border-royal text-royal' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'data-access' && <DataAccessTab onViewSession={onViewSession} />}
      {tab === 'redaction-review' && <RedactionReviewTab onViewSession={onViewSession} />}
      {tab === 'assistant' && <AssistantTab />}
      {tab === 'caseload' && <CaseloadTab />}
      {tab === 'wipes' && <WipesTab />}
    </div>
  );
}
