// Worksheet review tab (ai-therapist-89): the review half of the personalized
// worksheet loop. Queue on the left, the filled instance (participant answers,
// read-only) and the auto-stripped, editable template side by side on the
// right. Promote sends the reviewer-confirmed template to the knowledge base
// (pending approval); Reject records a note. Opening an instance is logged
// server-side as a 'worksheet_review' data access, which the footer says.
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, Eye, AlertTriangle } from 'react-feather';
import { getJson, postJson, HttpError } from '../../../shared/http';
import { formatDateTime } from './types';
import type {
  WorksheetReviewQueueRow,
  WorksheetReviewDetail,
  WorksheetSection,
} from '../../../../server/db/worksheets.queries';

interface DetailResponse {
  instance: WorksheetReviewDetail;
  template: { title: string; content: string };
}

/** Which answer belongs to a section: the client keys responses by label. */
function answerFor(responses: Record<string, string> | null, section: WorksheetSection, index: number): string {
  if (!responses) return '';
  return responses[section.label] ?? responses[String(index)] ?? '';
}

export default function WorksheetReviewPanel() {
  const [queue, setQueue] = useState<WorksheetReviewQueueRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    setError(null);
    try {
      const data = await getJson<{ instances?: WorksheetReviewQueueRow[]; total?: number }>(
        '/admin/api/worksheets/review?limit=100',
      );
      setQueue(data.instances ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the review queue');
    } finally {
      setLoadingQueue(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const open = async (id: number) => {
    setSelectedId(id);
    setDetail(null);
    setNotice(null);
    setError(null);
    setNote('');
    setLoadingDetail(true);
    try {
      const data = await getJson<DetailResponse>(`/admin/api/worksheets/review/${id}`);
      setDetail(data);
      setTitle(data.template.title);
      setContent(data.template.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the worksheet');
    } finally {
      setLoadingDetail(false);
    }
  };

  const finish = async (message: string) => {
    setNotice(message);
    setSelectedId(null);
    setDetail(null);
    await loadQueue();
  };

  const promote = async () => {
    if (selectedId === null) return;
    if (
      !confirm(
        'Promote this template to the knowledge base? Only the template text on the right is stored; it lands as pending approval.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<{ chunk_id: number; already_promoted?: boolean }>(
        `/admin/api/worksheets/review/${selectedId}/promote`,
        { title, content, ...(note.trim() ? { note: note.trim() } : {}) },
        { fallback: 'Promote failed' },
      );
      await finish(`Promoted as knowledge chunk #${res.chunk_id} (pending approval in the Content tab).`);
    } catch (e) {
      setError(e instanceof HttpError ? e.message : e instanceof Error ? e.message : 'Promote failed');
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (selectedId === null) return;
    if (!note.trim()) {
      setError('A note is required to reject (recorded on the instance).');
      return;
    }
    if (!confirm('Reject this worksheet? It leaves the queue and is not added to the knowledge base.')) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(
        `/admin/api/worksheets/review/${selectedId}/reject`,
        { note: note.trim() },
        { fallback: 'Reject failed' },
      );
      await finish('Worksheet rejected.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setBusy(false);
    }
  };

  const instance = detail?.instance ?? null;

  return (
    <div>
      <p className="text-sm text-gray-600 mb-4">
        Completed personalized worksheets wait here. The filled instance is shown for review only; what gets promoted is
        the de-personalised template on the right, which you can edit first. Participant answers never enter the
        knowledge base.
      </p>

      {notice && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4">
        {/* Queue */}
        <div className="bg-white rounded-lg shadow p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Queue ({total})</p>
            <button
              onClick={loadQueue}
              disabled={loadingQueue}
              title="Refresh"
              className="p-1 text-gray-500 hover:text-gray-800 disabled:opacity-40"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {loadingQueue && queue.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">Loading…</p>
          ) : queue.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">Nothing waiting for review.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {queue.map((row) => (
                <li key={row.instance_id}>
                  <button
                    onClick={() => open(row.instance_id)}
                    className={`w-full text-left px-2 py-2 rounded hover:bg-gray-50 ${selectedId === row.instance_id ? 'bg-royal/10' : ''}`}
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{row.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      #{row.instance_id} · {row.section_count} section{row.section_count === 1 ? '' : 's'}
                      {row.template_title ? ` · from "${row.template_title}"` : ' · no template'}
                    </p>
                    <p className="text-xs text-gray-400">
                      {row.user_id !== null ? `Participant ${row.user_id}` : 'Unknown participant'} ·{' '}
                      {row.completed_at ? formatDateTime(String(row.completed_at)) : 'completed'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="bg-white rounded-lg shadow p-4 min-h-[16rem]">
          {selectedId === null ? (
            <p className="text-sm text-gray-500 py-12 text-center">Select a worksheet from the queue to review it.</p>
          ) : loadingDetail || !instance ? (
            <p className="text-sm text-gray-500 py-12 text-center">Loading…</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                <div>
                  <p className="font-semibold text-gray-900">{instance.title}</p>
                  <p className="text-xs text-gray-500">
                    Instance #{instance.instance_id} · session {instance.session_id} ·{' '}
                    {instance.user_id !== null ? `participant ${instance.user_id}` : 'unknown participant'}
                    {instance.template_title && (
                      <>
                        {' '}
                        · template: {instance.template_title}
                        {instance.template_chunk_id !== null && ` (chunk #${instance.template_chunk_id})`}
                      </>
                    )}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  <Eye size={12} /> Viewing participant answers is recorded in the data access log
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Filled instance (read-only) */}
                <div>
                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Filled instance</p>
                  {instance.intro && (
                    <p className="text-sm text-gray-600 italic mb-3 whitespace-pre-wrap">{instance.intro}</p>
                  )}
                  <ol className="space-y-3">
                    {instance.sections.map((s, i) => (
                      <li key={i} className="border border-gray-200 rounded p-2">
                        <p className="text-xs text-gray-500">
                          {i + 1}. <span className="uppercase">{s.type}</span>
                        </p>
                        <p className="text-sm font-medium text-gray-900">{s.label}</p>
                        <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap bg-gray-50 rounded p-2">
                          {answerFor(instance.responses, s, i) || <span className="text-gray-400">(no answer)</span>}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Stripped template (editable) */}
                <div>
                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
                    Template to promote
                  </p>
                  <p className="text-xs text-gray-500 mb-2 inline-flex items-start gap-1">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                    <span>
                      Answers and the personalized intro are already stripped. Generalize any prompt wording that still
                      refers to this participant; the server refuses text that repeats an answer.
                    </span>
                  </p>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2"
                    placeholder="Template title"
                  />
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={16}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                  />
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mt-2"
                    placeholder="Review note (required to reject, optional to promote)"
                  />
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={promote}
                      disabled={busy || !content.trim() || !title.trim()}
                      className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center gap-1"
                    >
                      <CheckCircle size={14} /> {busy ? 'Working…' : 'Promote template'}
                    </button>
                    <button
                      onClick={reject}
                      disabled={busy}
                      className="px-4 py-2 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-40 inline-flex items-center gap-1"
                    >
                      <XCircle size={14} /> Reject
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
