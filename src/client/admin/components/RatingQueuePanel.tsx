// Rating queue (eval program WP2): the sessions sampled for blind human
// rating. Claim a row, open the session (the eval endpoints hide judge scores
// until the rater has saved their own), skip it, filter to "my queue"; a
// researcher can draw a fresh stratified sample or push the judge-disagreement
// sessions in. Also surfaces how many crisis events still need adjudication.
// Backed by /admin/api/evals/rating-queue*.
import { useState, useEffect, useCallback } from 'react';
import { List, RefreshCw, ExternalLink, SkipForward, UserCheck, AlertTriangle, Shuffle } from 'react-feather';
import { getJson, postJson, HttpError } from '../../shared/http';
import { toast } from '../../shared/components/Toast';
import useAuth from '../hooks/useAuth';

interface QueueItem {
  queue_id: number;
  session_id: string;
  stratum: string;
  source: 'stratified' | 'disagreement' | 'manual';
  status: 'queued' | 'in_progress' | 'rated' | 'skipped';
  assigned_to: number | null;
  second_rater_id: number | null;
  needs_second_rater: boolean;
  crisis_adjacent: boolean;
  enqueued_at: string;
  session_type: string | null;
  ended_at: string | null;
  anonymous: boolean;
  assigned_to_username: string | null;
  second_rater_username: string | null;
  rating_count: number;
  rated_by_me: boolean;
}

interface QueueCounts {
  queued: number;
  in_progress: number;
  rated: number;
  skipped: number;
  awaiting_second_rater: number;
  double_rated: number;
}

interface QueueResponse {
  items: QueueItem[];
  counts: QueueCounts;
  unadjudicated_crisis_events: number;
  second_rater_fraction: number;
  my_user_id: number | null;
}

interface SampleResult {
  dry_run: boolean;
  candidate_count: number;
  picks: Array<{ session_id: string; stratum: string; crisis_adjacent: boolean; needs_second_rater: boolean }>;
  allocations: Array<{ stratum: string; candidates: number; crisis_adjacent: number; allocated: number }>;
  inserted: unknown[];
}

const STATUS_CLASSES: Record<QueueItem['status'], string> = {
  queued: 'bg-gray-100 text-gray-700',
  in_progress: 'bg-blue-100 text-blue-800',
  rated: 'bg-green-100 text-green-800',
  skipped: 'bg-gray-200 text-gray-500',
};

/** Can this user still contribute a rating to the row? */
function canRate(item: QueueItem, userId: number | null): boolean {
  if (item.status === 'rated' || item.status === 'skipped' || item.rated_by_me) return false;
  if (item.assigned_to === null || item.assigned_to === userId || item.second_rater_id === userId) return true;
  return item.needs_second_rater && item.second_rater_id === null;
}

export default function RatingQueuePanel({ onViewSession }: { onViewSession?: (sessionId: string) => void }) {
  const { role, userId } = useAuth();
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState<'open' | 'all' | 'rated' | 'skipped'>('open');
  const [sampleSize, setSampleSize] = useState(20);
  const [sampling, setSampling] = useState(false);
  const [preview, setPreview] = useState<SampleResult | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (mine) qs.set('scope', 'mine');
      if (status !== 'all') qs.set('status', status);
      const d = await getJson<QueueResponse>(`/admin/api/evals/rating-queue?${qs.toString()}`, {
        fallback: 'Failed to load rating queue',
      });
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [mine, status]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (item: QueueItem, action: 'claim' | 'skip') => {
    setBusyId(item.queue_id);
    try {
      await postJson(
        `/admin/api/evals/rating-queue/${item.queue_id}/${action}`,
        {},
        { fallback: `Failed to ${action}` },
      );
      toast.success(action === 'claim' ? 'Claimed' : 'Skipped');
      await load();
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : `Failed to ${action}`);
    } finally {
      setBusyId(null);
    }
  };

  const claimAndOpen = async (item: QueueItem) => {
    if (item.status === 'queued' || (item.assigned_to !== userId && item.second_rater_id !== userId)) {
      await act(item, 'claim');
    }
    onViewSession?.(item.session_id);
  };

  const sample = async (dryRun: boolean) => {
    setSampling(true);
    try {
      const result = await postJson<SampleResult>(
        '/admin/api/evals/rating-queue/sample',
        { size: sampleSize, dry_run: dryRun },
        { fallback: 'Sampling failed' },
      );
      if (dryRun) {
        setPreview(result);
      } else {
        setPreview(null);
        toast.success(`Enqueued ${result.inserted.length} session${result.inserted.length === 1 ? '' : 's'}`);
        await load();
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : 'Sampling failed');
    } finally {
      setSampling(false);
    }
  };

  const enqueueDisagreement = async () => {
    setSampling(true);
    try {
      const cal = await getJson<{
        judge_agreement?: { high_disagreement: Array<{ session_id: string; max_spread: number }> };
      }>('/admin/api/evals/calibration');
      const ids = (cal.judge_agreement?.high_disagreement ?? [])
        .filter((h) => h.max_spread > 0)
        .map((h) => h.session_id);
      if (ids.length === 0) {
        toast.info('No judge-disagreement sessions to enqueue');
        return;
      }
      const result = await postJson<{ inserted: unknown[]; skipped: string[] }>(
        '/admin/api/evals/rating-queue/enqueue',
        { session_ids: ids, source: 'disagreement' },
        { fallback: 'Enqueue failed' },
      );
      toast.success(
        `Enqueued ${result.inserted.length} disagreement session${result.inserted.length === 1 ? '' : 's'}`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : 'Enqueue failed');
    } finally {
      setSampling(false);
    }
  };

  const counts = data?.counts;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <List size={20} /> Rating queue
        </h3>
        <button
          onClick={load}
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-navy"
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {counts && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {[
            ['Queued', counts.queued],
            ['In progress', counts.in_progress],
            ['Rated', counts.rated],
            ['Awaiting 2nd rater', counts.awaiting_second_rater],
            ['Double-rated', counts.double_rated],
          ].map(([label, n]) => (
            <div key={String(label)} className="bg-white p-4 rounded-lg shadow">
              <p className="text-xs text-gray-600">{label}</p>
              <p className="text-2xl font-bold text-navy mt-1">{n}</p>
            </div>
          ))}
          <div
            className={`p-4 rounded-lg shadow ${data && data.unadjudicated_crisis_events > 0 ? 'bg-yellow-50' : 'bg-white'}`}
          >
            <p className="text-xs text-gray-600 inline-flex items-center gap-1">
              <AlertTriangle size={12} /> Unadjudicated crisis events
            </p>
            <p className="text-2xl font-bold text-navy mt-1">{data?.unadjudicated_crisis_events ?? 0}</p>
          </div>
        </div>
      )}

      {role === 'researcher' && (
        <div className="bg-white p-4 rounded-lg shadow flex items-center gap-3 flex-wrap text-sm">
          <Shuffle size={16} className="text-gray-600" />
          <label className="flex items-center gap-2">
            Sample size
            <input
              type="number"
              min={1}
              max={500}
              value={sampleSize}
              onChange={(e) => setSampleSize(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="w-20 border border-gray-300 rounded px-2 py-1"
            />
          </label>
          <button
            onClick={() => sample(true)}
            disabled={sampling}
            className="px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 min-h-[36px]"
          >
            Preview allocation
          </button>
          <button
            onClick={() => sample(false)}
            disabled={sampling}
            className="px-3 py-1.5 bg-royal text-white rounded hover:bg-navy disabled:opacity-50 min-h-[36px]"
          >
            Draw stratified sample
          </button>
          <button
            onClick={enqueueDisagreement}
            disabled={sampling}
            className="px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 min-h-[36px]"
          >
            Enqueue judge-disagreement sessions
          </button>
          <span className="text-xs text-gray-500">
            Stratified by modality × risk band × ISO week, crisis-adjacent oversampled;{' '}
            {data ? Math.round(data.second_rater_fraction * 100) : 20}% get a second rater.
          </span>
        </div>
      )}

      {preview && (
        <div className="bg-white p-4 rounded-lg shadow text-sm">
          <p className="font-medium mb-2">
            Preview: {preview.picks.length} of {preview.candidate_count} candidates would be enqueued (
            {preview.picks.filter((p) => p.crisis_adjacent).length} crisis-adjacent,{' '}
            {preview.picks.filter((p) => p.needs_second_rater).length} with a second rater)
          </p>
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-1 pr-4">Stratum</th>
                <th className="py-1 pr-4">Candidates</th>
                <th className="py-1 pr-4">Crisis-adjacent</th>
                <th className="py-1 pr-4">Allocated</th>
              </tr>
            </thead>
            <tbody>
              {preview.allocations.map((a) => (
                <tr key={a.stratum} className="border-b last:border-0">
                  <td className="py-1 pr-4 font-mono">{a.stratum}</td>
                  <td className="py-1 pr-4">{a.candidates}</td>
                  <td className="py-1 pr-4">{a.crisis_adjacent}</td>
                  <td className="py-1 pr-4">{a.allocated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-4 text-sm flex-wrap">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> My queue
        </label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="border border-gray-300 rounded px-2 py-1"
        >
          <option value="open">Open (queued + in progress)</option>
          <option value="rated">Rated</option>
          <option value="skipped">Skipped</option>
          <option value="all">All</option>
        </select>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        {error && <p className="text-red-600 p-4">{error}</p>}
        {!error && data && data.items.length === 0 && (
          <p className="text-gray-500 p-6 text-center">Nothing in the queue for this filter.</p>
        )}
        {!error && data && data.items.length > 0 && (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 px-3">Session</th>
                <th className="py-2 px-3">Stratum</th>
                <th className="py-2 px-3">Source</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Raters</th>
                <th className="py-2 px-3">Ended</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.queue_id} className="border-b last:border-0 align-top">
                  <td className="py-2 px-3 font-mono text-xs">
                    {item.session_id}
                    {item.crisis_adjacent && (
                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-semibold">
                        <AlertTriangle size={10} /> crisis-adjacent
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs">{item.stratum}</td>
                  <td className="py-2 px-3 text-xs">{item.source}</td>
                  <td className="py-2 px-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_CLASSES[item.status]}`}>
                      {item.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs text-gray-700">
                    {item.assigned_to_username ?? (item.assigned_to ? `user ${item.assigned_to}` : '—')}
                    {item.needs_second_rater && (
                      <>
                        {' '}
                        +{' '}
                        {item.second_rater_username ??
                          (item.second_rater_id ? (
                            `user ${item.second_rater_id}`
                          ) : (
                            <span className="text-gray-400">2nd rater open</span>
                          ))}
                      </>
                    )}
                    <div className="text-gray-500">
                      {item.rating_count} rating{item.rating_count === 1 ? '' : 's'}
                      {item.rated_by_me ? ' · yours saved' : ''}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-xs text-gray-600">
                    {item.ended_at ? new Date(item.ended_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {canRate(item, userId) && (
                        <button
                          onClick={() => claimAndOpen(item)}
                          disabled={busyId === item.queue_id}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-royal text-white rounded hover:bg-navy text-xs disabled:opacity-50 min-h-[28px]"
                          title="Claim and open the session in blind mode"
                        >
                          <UserCheck size={12} />{' '}
                          {item.assigned_to === userId || item.second_rater_id === userId ? 'Rate' : 'Claim and rate'}
                        </button>
                      )}
                      <button
                        onClick={() => onViewSession?.(item.session_id)}
                        className="inline-flex items-center gap-1 px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 text-xs min-h-[28px]"
                      >
                        <ExternalLink size={12} /> Open
                      </button>
                      {(item.status === 'queued' || item.status === 'in_progress') && (
                        <button
                          onClick={() => act(item, 'skip')}
                          disabled={busyId === item.queue_id}
                          className="inline-flex items-center gap-1 px-2 py-1 text-gray-600 hover:text-navy text-xs disabled:opacity-50 min-h-[28px]"
                        >
                          <SkipForward size={12} /> Skip
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-600">
        Ratings are blind: opening a queued session hides the judge&apos;s scores and rationale (and other raters&apos;
        scores) until your rating is saved, then both appear side by side. Reading the transcript is recorded in the
        Data Access audit as usual.
      </p>
    </div>
  );
}
