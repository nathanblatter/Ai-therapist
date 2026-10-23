// Admin usage telemetry (ai-therapist-205): which admin screens get opened,
// by which role cohort, how often, and which views are dead weight in the
// window. Reads /admin/api/telemetry/admin-usage (researcher-only), fed by
// the de-identified admin_usage_events table (migration 096) — role cohorts
// only, never a person.
import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Eye, EyeOff, Layers, AlertTriangle } from 'react-feather';
import useAdminFetch from '../../hooks/useAdminFetch';
import Panel from '../ui/Panel';
import StatCard from '../ui/StatCard';
import { formatVisible, SERIES_PRIMARY, GRID_STROKE, AXIS_TICK } from './telemetryFormat';

interface KindStat {
  kind: string;
  count: number;
  last_seen: string;
}
interface ReachRow {
  view: string;
  opens: number;
}
interface ByRoleRow {
  view: string;
  role: string;
  opens: number;
  visible_ms: number;
}
interface AdminUsageData {
  days: number;
  kinds: KindStat[];
  reach: ReachRow[];
  byRole: ByRoleRow[];
}

// Every view id the admin shell can report (AdminApp.tsx nav ids plus the
// header-launched MFA view). A view in this list with no opens in the window
// is "dead weight". Keep in sync with the navGroups in AdminApp.tsx.
export const KNOWN_ADMIN_VIEWS: Record<string, string> = {
  triage: 'Triage',
  'work-queue': 'Work Queue',
  live: 'Live Monitoring',
  sessions: 'Sessions',
  dashboard: 'Analytics',
  assistant: 'Assistant',
  crisis: 'Crisis Management',
  escalations: 'Escalations',
  'adverse-events': 'Adverse Events',
  users: 'Users',
  caseload: 'Caseload',
  messages: 'Messages',
  'user-sessions': 'User Sessions',
  'rate-limits': 'Rate Limits',
  prompts: 'System Prompts',
  knowledge: 'Knowledge Base',
  evals: 'Evals',
  redaction: 'Redaction Review',
  consent: 'Consent Versions',
  'study-ops': 'Study Ops',
  sandbox: 'Sandbox Invites',
  qualtrics: 'Qualtrics Sync',
  'survey-data': 'Survey Data',
  export: 'Export',
  costs: 'OpenAI Spend',
  config: 'System Config',
  retention: 'Data Retention',
  mfa: 'MFA Security',
};

const ROLE_ORDER = ['therapist', 'caseworker', 'researcher', 'demo', 'unknown'];

function viewLabel(view: string): string {
  return KNOWN_ADMIN_VIEWS[view] ?? view;
}

const WINDOWS = [7, 30, 90] as const;

export default function AdminUsagePanel() {
  const [days, setDays] = useState<number>(30);
  const { data, loading, error } = useAdminFetch<AdminUsageData>(`/admin/api/telemetry/admin-usage?days=${days}`);

  const windowPicker = (
    <div className="flex gap-1" role="group" aria-label="Window">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => setDays(w)}
          aria-pressed={days === w}
          className={`px-3 py-1 text-sm rounded border ${days === w ? 'bg-royal text-white border-royal' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
        >
          {w}d
        </button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <Panel>
        <p className="text-gray-500 text-center py-4">Loading admin usage telemetry...</p>
      </Panel>
    );
  }
  if (error || !data) {
    return (
      <Panel>
        <p className="text-red-600 text-center py-4">{error || 'No admin usage telemetry available'}</p>
      </Panel>
    );
  }

  const totalOpens = data.reach.reduce((a, r) => a + r.opens, 0);
  const seenViews = new Set(data.reach.map((r) => r.view));
  const deadViews = Object.keys(KNOWN_ADMIN_VIEWS).filter((v) => !seenViews.has(v));
  const jsErrors = data.kinds.find((k) => k.kind === 'js_error')?.count ?? 0;
  const apiErrors = data.kinds.find((k) => k.kind === 'api_error')?.count ?? 0;

  const roles = ROLE_ORDER.filter((r) => data.byRole.some((b) => b.role === r)).concat(
    Array.from(new Set(data.byRole.map((b) => b.role))).filter((r) => !ROLE_ORDER.includes(r)),
  );
  const byView = new Map<string, { opens: number; visible_ms: number; perRole: Record<string, number> }>();
  for (const row of data.byRole) {
    const entry = byView.get(row.view) ?? { opens: 0, visible_ms: 0, perRole: {} };
    entry.opens += row.opens;
    entry.visible_ms += row.visible_ms;
    entry.perRole[row.role] = (entry.perRole[row.role] ?? 0) + row.opens;
    byView.set(row.view, entry);
  }
  const viewRows = Array.from(byView.entries())
    .map(([view, v]) => ({ view, ...v }))
    .sort((a, b) => b.opens - a.opens || a.view.localeCompare(b.view));

  const chartData = data.reach.slice(0, 15).map((r) => ({ name: viewLabel(r.view), opens: r.opens }));
  const chartHeight = Math.max(160, chartData.length * 28 + 40);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Layers size={20} /> Admin Usage
          </h3>
          <p className="text-sm text-gray-600">
            De-identified screen usage over the last {data.days} days: role cohorts only, no per-person history.
          </p>
        </div>
        {windowPicker}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="View opens" value={totalOpens} sub={`${seenViews.size} distinct screens`} icon={Eye} />
        <StatCard label="Dead weight" value={deadViews.length} sub="screens with zero opens" icon={EyeOff} />
        <StatCard label="JS errors" value={jsErrors} sub="uncaught in the admin app" icon={AlertTriangle} />
        <StatCard label="API errors" value={apiErrors} sub="failed admin API calls" icon={AlertTriangle} />
      </div>

      <Panel title="Opens by Screen">
        {chartData.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">
            No view opens recorded in this window. The stream is on when features.telemetry_admin_usage is true (System
            Config).
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ left: 8, right: 24, top: 4, bottom: 4 }}
              barCategoryGap={6}
            >
              <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
              <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={140} tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: '#F3F4F6' }} formatter={(v) => [String(v), 'Opens']} />
              <Bar dataKey="opens" name="Opens" fill={SERIES_PRIMARY} radius={[0, 4, 4, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title="Screens by Role" className="overflow-x-auto">
        <p className="text-sm text-gray-600 mb-3">
          Opens per role cohort and total visible time (from attention heartbeats, so background tabs do not count).
        </p>
        {viewRows.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">Nothing recorded in this window.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Screen</th>
                <th className="py-2 pr-4 text-right">Opens</th>
                {roles.map((r) => (
                  <th key={r} className="py-2 pr-4 text-right capitalize">
                    {r}
                  </th>
                ))}
                <th className="py-2 pr-4 text-right">Visible time</th>
              </tr>
            </thead>
            <tbody>
              {viewRows.map((row) => (
                <tr key={row.view} className="border-b last:border-0">
                  <td className="py-2 pr-4">{viewLabel(row.view)}</td>
                  <td className="py-2 pr-4 text-right">{row.opens}</td>
                  {roles.map((r) => (
                    <td key={r} className="py-2 pr-4 text-right text-gray-700">
                      {row.perRole[r] ?? 0}
                    </td>
                  ))}
                  <td className="py-2 pr-4 text-right text-gray-700">
                    {row.visible_ms > 0 ? formatVisible(row.visible_ms) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Dead Weight" icon={EyeOff}>
        <p className="text-sm text-gray-600 mb-3">
          Screens nobody opened in the last {data.days} days. Candidates to cut or fold into another view.
        </p>
        {deadViews.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">Every known screen was opened at least once.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {deadViews.map((v) => (
              <li key={v} className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-700">
                {viewLabel(v)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Event Kinds" className="overflow-x-auto">
        {data.kinds.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">No admin usage events in this window.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Kind</th>
                <th className="py-2 pr-4 text-right">Count</th>
                <th className="py-2 pr-4">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.kinds.map((k) => (
                <tr key={k.kind} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{k.kind}</td>
                  <td className="py-2 pr-4 text-right">{k.count}</td>
                  <td className="py-2 pr-4">{k.last_seen ? new Date(k.last_seen).toLocaleString() : 'N/A'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
