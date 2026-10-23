import { useState, useEffect, useCallback } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { RefreshCw, Play, Plus, AlertTriangle, CheckCircle, AlertCircle, Save, Printer, Download } from 'react-feather';
import { deleteJson, getJson, postJson, requestJson } from '../../shared/http';
// Canonical protocol shape lives in the server data layer (type-only import,
// erased at build time).
import type { StudyProtocol } from '../../../server/db/studyOps.queries';

interface Summary {
  protocol: StudyProtocol;
  enrollment: {
    enrolled_participants: number;
    anonymous_sessions: number;
    target: number;
    weekly: { week: string; new_participants: number }[];
  };
  arm_balance: {
    arm_true: number;
    arm_false: number;
    arm_null: number;
    imbalance: number | null;
    threshold: number;
    over_threshold: boolean;
  };
  sessions_per_participant: {
    histogram: { n_sessions: number; n_participants: number }[];
    expected: number;
    below_expected: number;
    at_expected: number;
    above_expected: number;
  };
  conditions: { dimension: string; value: string; n: number }[];
  deviations: { open: number; major_open: number };
}

interface Deviation {
  deviation_id: number;
  occurred_at: string;
  source: string;
  category: string;
  severity: string;
  session_id: string | null;
  description: string;
  status: string;
  created_by: string | null;
  resolved_by: string | null;
}

const MANUAL_CATEGORIES = ['technical_failure', 'enrollment', 'procedure', 'other'];

/** YYYY-MM-DD in UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function StudyOps() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [deviations, setDeviations] = useState<Deviation[]>([]);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [protocolDraft, setProtocolDraft] = useState<StudyProtocol | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The deviations list is best-effort: a failure there keeps the stale list.
      const [s, d] = await Promise.all([
        getJson<Summary>('/admin/api/study-ops/summary', { fallback: 'Failed to load summary' }),
        getJson<{ deviations: Deviation[] }>(`/admin/api/study-ops/deviations?status=${statusFilter}`).catch(
          () => null,
        ),
      ]);
      setSummary(s);
      setProtocolDraft(s.protocol);
      if (d) setDeviations(d.deviations);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const runScan = async () => {
    setScanning(true);
    setNotice(null);
    setError(null);
    try {
      const data = await postJson<{ inserted: number }>('/admin/api/study-ops/scan', undefined, {
        fallback: 'Scan failed',
      });
      setNotice(`Scan complete: ${data.inserted} new deviation(s) flagged.`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const patchDeviation = async (id: number, patch: Record<string, unknown>) => {
    try {
      await requestJson(`/admin/api/study-ops/deviations/${id}`, {
        method: 'PATCH',
        body: patch,
        fallback: 'Update failed',
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeDeviation = async (id: number) => {
    if (!window.confirm('Delete this manual deviation?')) return;
    try {
      await deleteJson(`/admin/api/study-ops/deviations/${id}`, undefined, {
        fallback: 'Delete failed (auto-flagged rows cannot be deleted)',
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProtocol = async () => {
    if (!protocolDraft) return;
    setNotice(null);
    setError(null);
    try {
      await postJson('/admin/api/study-ops/protocol', protocolDraft, {
        method: 'PUT',
        fallback: 'Failed to save protocol',
      });
      setNotice('Protocol targets saved.');
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Loading study ops…</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Study Ops</h2>
          <p className="text-sm text-gray-600 mt-1">
            Enrollment, arm balance, and protocol deviations (demo data excluded).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchAll}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={runScan}
            disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-lg hover:bg-navy disabled:opacity-50"
          >
            <Play size={16} /> {scanning ? 'Scanning…' : 'Run scan'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}
      {notice && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-start gap-3">
          <CheckCircle className="text-green-600 flex-shrink-0 mt-0.5" size={20} />
          <p className="text-green-700 text-sm">{notice}</p>
        </div>
      )}

      {summary && (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-xs font-medium uppercase text-gray-500">Enrollment</p>
              <p className="text-2xl font-bold text-gray-900">
                {summary.enrollment.enrolled_participants}
                <span className="text-base font-normal text-gray-400"> / {summary.enrollment.target}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">+{summary.enrollment.anonymous_sessions} anonymous sessions</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-xs font-medium uppercase text-gray-500">Arm imbalance</p>
              <p
                className={`text-2xl font-bold ${summary.arm_balance.over_threshold ? 'text-red-600' : 'text-gray-900'}`}
              >
                {summary.arm_balance.imbalance == null ? '—' : summary.arm_balance.imbalance.toFixed(3)}
              </p>
              <p className="text-xs text-gray-500 mt-1">threshold {summary.arm_balance.threshold}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-xs font-medium uppercase text-gray-500">Open deviations</p>
              <p className="text-2xl font-bold text-gray-900">{summary.deviations.open}</p>
              <p className="text-xs text-gray-500 mt-1">{summary.deviations.major_open} major</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-xs font-medium uppercase text-gray-500">Sessions / participant</p>
              <p className="text-2xl font-bold text-gray-900">
                {summary.sessions_per_participant.at_expected + summary.sessions_per_participant.above_expected}
                <span className="text-base font-normal text-gray-400"> at/above expected</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">{summary.sessions_per_participant.below_expected} below</p>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Weekly enrollment</h3>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={summary.enrollment.weekly}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="week" fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} />
                  <Tooltip />
                  <Line type="monotone" dataKey="new_participants" stroke="#4f46e5" name="New participants" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                proactive_offering arm balance
                {summary.arm_balance.over_threshold && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-red-700">
                    <AlertTriangle size={12} /> over threshold
                  </span>
                )}
              </h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={[
                    { arm: 'true', n: summary.arm_balance.arm_true },
                    { arm: 'false', n: summary.arm_balance.arm_false },
                    { arm: 'null', n: summary.arm_balance.arm_null },
                  ]}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="arm" fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="n" fill="#4f46e5" name="Sessions" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Sessions per participant (reference: expected {summary.sessions_per_participant.expected})
            </h3>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={summary.sessions_per_participant.histogram}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="n_sessions" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <ReferenceLine x={summary.sessions_per_participant.expected} stroke="#dc2626" strokeDasharray="4 4" />
                <Bar dataKey="n_participants" fill="#059669" name="Participants" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Protocol targets */}
          {protocolDraft && (
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Protocol targets</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="block text-sm">
                  <span className="text-gray-700">Enrollment target</span>
                  <input
                    type="number"
                    value={protocolDraft.enrollment_target}
                    min={1}
                    onChange={(e) =>
                      setProtocolDraft({ ...protocolDraft, enrollment_target: parseInt(e.target.value) || 1 })
                    }
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">Expected sessions / participant</span>
                  <input
                    type="number"
                    value={protocolDraft.expected_sessions_per_participant}
                    min={1}
                    onChange={(e) =>
                      setProtocolDraft({
                        ...protocolDraft,
                        expected_sessions_per_participant: parseInt(e.target.value) || 1,
                      })
                    }
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">Arm imbalance threshold (0-1)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={protocolDraft.arm_imbalance_threshold}
                    min={0}
                    max={1}
                    onChange={(e) =>
                      setProtocolDraft({ ...protocolDraft, arm_imbalance_threshold: parseFloat(e.target.value) || 0 })
                    }
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">Study start (ISO date, optional)</span>
                  <input
                    type="date"
                    value={protocolDraft.study_start?.slice(0, 10) ?? ''}
                    onChange={(e) => setProtocolDraft({ ...protocolDraft, study_start: e.target.value || null })}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">Study end (ISO date, optional)</span>
                  <input
                    type="date"
                    value={protocolDraft.study_end?.slice(0, 10) ?? ''}
                    onChange={(e) => setProtocolDraft({ ...protocolDraft, study_end: e.target.value || null })}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">IRB protocol id</span>
                  <input
                    type="text"
                    value={protocolDraft.protocol_id ?? ''}
                    maxLength={200}
                    placeholder="e.g. 2025-519-BYU"
                    onChange={(e) => setProtocolDraft({ ...protocolDraft, protocol_id: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">Principal investigator</span>
                  <input
                    type="text"
                    value={protocolDraft.principal_investigator ?? ''}
                    maxLength={200}
                    onChange={(e) => setProtocolDraft({ ...protocolDraft, principal_investigator: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-700">Study title</span>
                  <input
                    type="text"
                    value={protocolDraft.study_title ?? ''}
                    maxLength={200}
                    onChange={(e) => setProtocolDraft({ ...protocolDraft, study_title: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    onClick={saveProtocol}
                    className="flex items-center gap-2 px-4 py-2 bg-royal text-white rounded-lg hover:bg-navy"
                  >
                    <Save size={16} /> Save targets
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">Protocol id, PI and title appear in the IRB packet header.</p>
            </div>
          )}

          <IrbPacketSection />
        </>
      )}

      {/* Deviations table */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Protocol deviations</h3>
          <div className="flex gap-2 items-center">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'open' | 'all')}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="open">Open</option>
              <option value="all">All</option>
            </select>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        {showAdd && <AddDeviationForm onClose={() => setShowAdd(false)} onDone={fetchAll} setError={setError} />}

        <p className="text-xs text-gray-500 mb-3">Reminder: deviation descriptions must not contain participant PII.</p>

        {deviations.length === 0 ? (
          <p className="text-sm text-gray-500">No deviations.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {['When', 'Source', 'Category', 'Severity', 'Description', 'Status', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {deviations.map((d) => (
                  <tr key={d.deviation_id}>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                      {new Date(d.occurred_at).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${d.source === 'auto' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'}`}
                      >
                        {d.source}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-700">{d.category}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${d.severity === 'major' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-700'}`}
                      >
                        {d.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-700 max-w-md">{d.description}</td>
                    <td className="px-3 py-2">
                      <select
                        value={d.status}
                        onChange={(e) => patchDeviation(d.deviation_id, { status: e.target.value })}
                        className="border border-gray-200 rounded px-1 py-0.5 text-xs"
                      >
                        {['open', 'acknowledged', 'resolved', 'dismissed'].map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {d.source === 'manual' && (
                        <button
                          onClick={() => removeDeviation(d.deviation_id)}
                          className="text-red-600 hover:text-red-800 text-xs"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** IRB continuing-review packet (ai-therapist-107): a printable report plus a
 *  zip of JSON/CSV attachments over a date range. Generation is server-side
 *  and audited, so the buttons just open the route URLs. */
function IrbPacketSection() {
  const today = new Date();
  const yearAgo = new Date(today);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const [from, setFrom] = useState(isoDay(yearAgo));
  const [to, setTo] = useState(isoDay(today));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-1">IRB packet</h3>
      <p className="text-sm text-gray-600 mb-4">
        Continuing-review packet for the period: enrollment, sessions, safety, adverse events, deviations, consent
        versions, monitoring and data access. Counts only; adverse events and deviations are listed without participant
        identifiers. Incidents and the narrative are filled in by hand.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block text-sm">
          <span className="text-gray-700">From</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 block px-3 py-2 border border-gray-300 rounded-lg"
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">To</span>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 block px-3 py-2 border border-gray-300 rounded-lg"
          />
        </label>
        <a
          href={valid ? `/admin/api/irb/packet.html?${qs}` : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!valid}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-white ${valid ? 'bg-royal hover:bg-navy' : 'bg-gray-300 pointer-events-none'}`}
        >
          <Printer size={16} /> Open printable
        </a>
        <a
          href={valid ? `/admin/api/irb/packet.zip?${qs}` : undefined}
          aria-disabled={!valid}
          className={`flex items-center gap-2 px-4 py-2 border rounded-lg ${valid ? 'border-gray-300 hover:bg-gray-50 text-gray-800' : 'border-gray-200 text-gray-400 pointer-events-none'}`}
        >
          <Download size={16} /> Download zip
        </a>
      </div>
      <p className="text-xs text-gray-500 mt-3">Each generation is recorded in the data-access log.</p>
    </div>
  );
}

function AddDeviationForm({
  onClose,
  onDone,
  setError,
}: {
  onClose: () => void;
  onDone: () => void;
  setError: (s: string) => void;
}) {
  const [category, setCategory] = useState('technical_failure');
  const [severity, setSeverity] = useState('minor');
  const [description, setDescription] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!description.trim()) {
      setError('Description is required');
      return;
    }
    setSaving(true);
    try {
      await postJson(
        '/admin/api/study-ops/deviations',
        { category, severity, description, session_id: sessionId || null },
        { fallback: 'Create failed' },
      );
      setDescription('');
      setSessionId('');
      onClose();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm"
        >
          {MANUAL_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1.5 text-sm"
        >
          <option value="minor">minor</option>
          <option value="major">major</option>
        </select>
        <input
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          placeholder="session_id (optional)"
          className="border border-gray-300 rounded px-2 py-1.5 text-sm"
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="Description (no participant PII)"
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className="px-4 py-1.5 bg-royal text-white rounded-lg hover:bg-navy disabled:opacity-50 text-sm"
        >
          {saving ? 'Saving…' : 'Save deviation'}
        </button>
        <button onClick={onClose} className="px-4 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
