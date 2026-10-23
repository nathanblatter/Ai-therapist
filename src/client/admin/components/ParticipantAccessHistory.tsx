// "Who has seen this participant's data?" (ai-therapist-197). Renders one
// participant's data_access_log history: a per-actor rollup first (the
// one-glance answer), then the row-level trail. Embedded in the participant
// profile and in the Data Access view's drill-in. Opening it is itself logged
// server-side as an 'audit_log_view' access, which the footer says plainly.
import { useState } from 'react';
import { Eye } from 'react-feather';
import useAdminFetch from '../hooks/useAdminFetch';
import { formatDateTime } from '../../shared/format';
import type { DataAccessLogRow, ParticipantAccessActor } from '../../../server/db/accessLog.queries';

export const DATA_ACCESS_ACTION_LABELS: Record<string, string> = {
  transcript_view: 'Transcript viewed',
  recording_stream: 'Recording played',
  recording_download: 'Recording downloaded',
  export: 'Session export',
  dataset_export: 'Dataset export',
  audit_log_view: 'Access history viewed',
  worksheet_review: 'Worksheet reviewed',
};

/** Label for one row; the chart bundle (ai-therapist-199) shares the
 *  'export' action and is told apart by detail.kind. */
export function actionLabel(action: string, detail?: unknown): string {
  if (action === 'export' && detail && typeof detail === 'object' &&
      (detail as { kind?: unknown }).kind === 'client_chart') {
    return 'Chart exported';
  }
  return DATA_ACCESS_ACTION_LABELS[action] ?? action;
}

/** Compact human rendering of the JSONB detail column. */
export function detailSummary(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

interface HistoryResponse {
  rows: DataAccessLogRow[];
  actors: ParticipantAccessActor[];
  total: number;
  limit: number;
  offset: number;
}

interface Props {
  userId: number;
  /** Rows per page of the detailed trail. */
  pageSize?: number;
  onViewSession?: (sessionId: string) => void;
}

export const TH = 'px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
export const TD = 'px-4 py-2 text-sm text-gray-700 align-top';

export default function ParticipantAccessHistory({ userId, pageSize = 25, onViewSession }: Props) {
  const [offset, setOffset] = useState(0);
  const { data, loading, error } = useAdminFetch<HistoryResponse>(
    `/admin/api/audit/data-access/participant/${userId}?limit=${pageSize}&offset=${offset}`
  );

  if (loading && !data) return <p className="text-sm text-gray-500">Loading access history…</p>;
  if (error) {
    return (
      <p className="text-sm text-gray-500">
        {error.includes('(404)') ? 'Not available for this participant.' : `Could not load access history: ${error}`}
      </p>
    );
  }
  if (!data) return null;

  const total = data.total;
  const pageEnd = Math.min(offset + pageSize, total);

  return (
    <div className="space-y-4">
      {data.actors.length === 0 ? (
        <p className="text-sm text-gray-500">No staff member has viewed, played, or exported this participant&apos;s data.</p>
      ) : (
        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">By actor and action</p>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full divide-y divide-gray-200" role="table">
              <thead className="bg-gray-50">
                <tr>
                  <th className={TH} scope="col">Who</th>
                  <th className={TH} scope="col">Role</th>
                  <th className={TH} scope="col">Action</th>
                  <th className={`${TH} text-right`} scope="col">Times</th>
                  <th className={TH} scope="col">First</th>
                  <th className={TH} scope="col">Most recent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {data.actors.map(a => (
                  <tr key={`${a.accessed_by ?? 'none'}-${a.action}`}>
                    <td className={`${TD} font-medium text-gray-900`}>{a.actor_username ?? (a.accessed_by !== null ? `user #${a.accessed_by}` : 'unknown')}</td>
                    <td className={TD}>{a.role ?? '—'}</td>
                    <td className={TD}>{actionLabel(a.action)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{a.count}</td>
                    <td className={`${TD} whitespace-nowrap`}>{formatDateTime(a.first_at)}</td>
                    <td className={`${TD} whitespace-nowrap`}>{formatDateTime(a.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-500">Every access, newest first</p>
            <p className="text-xs text-gray-500">{offset + 1}–{pageEnd} of {total}</p>
          </div>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full divide-y divide-gray-200" role="table">
              <thead className="bg-gray-50">
                <tr>
                  <th className={TH} scope="col">When</th>
                  <th className={TH} scope="col">Who</th>
                  <th className={TH} scope="col">Action</th>
                  <th className={TH} scope="col">Session</th>
                  <th className={TH} scope="col">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td className={`${TD} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td>
                    <td className={TD}>
                      <span className="font-medium text-gray-900">{r.actor_username ?? (r.accessed_by !== null ? `user #${r.accessed_by}` : 'unknown')}</span>
                      {r.role && <span className="text-xs text-gray-500 ml-1">({r.role})</span>}
                    </td>
                    <td className={TD}>{actionLabel(r.action, r.detail)}</td>
                    <td className={`${TD} font-mono text-xs`}>
                      {r.session_id ? (
                        onViewSession ? (
                          <button onClick={() => onViewSession(r.session_id!)} className="text-royal hover:underline">
                            {r.session_id.slice(0, 8)}…
                          </button>
                        ) : (
                          <span title={r.session_id}>{r.session_id.slice(0, 8)}…</span>
                        )
                      ) : '—'}
                    </td>
                    <td className={`${TD} text-xs text-gray-500`}>{detailSummary(r.detail) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > pageSize && (
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
                disabled={offset === 0}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setOffset(offset + pageSize)}
                disabled={pageEnd >= total}
                className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400 flex items-center gap-1">
        <Eye size={12} /> Viewing this history is itself recorded in the access log.
      </p>
    </div>
  );
}
