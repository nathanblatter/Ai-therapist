// Ops telemetry panel (pass-3 telemetry): in-process HTTP metrics (rolling
// 60-min window), process health, client error-beacon aggregation, and the
// product funnel. Rendered on the Performance tab of the Analytics dashboard;
// data comes from /admin/api/analytics/ops and /admin/api/analytics/funnel.
import { Server, AlertTriangle, Clock, Cpu, Activity } from "react-feather";
import useAdminFetch from "../hooks/useAdminFetch";
import Panel from "./ui/Panel";
import StatCard from "./ui/StatCard";

interface GroupErrorRates {
  count_4xx: number;
  count_5xx: number;
  rate_4xx: number;
  rate_5xx: number;
}

interface GroupLatency {
  p50_ms: number | null;
  p95_ms: number | null;
}

interface ClientErrorStat {
  kind: string;
  count: number;
  last_seen: string;
}

interface OpsData {
  window_minutes: number;
  requests: Record<string, number>;
  errorRates: Record<string, GroupErrorRates>;
  latency: Record<string, GroupLatency>;
  uptime: number;
  memory: { rss: number; heap_used: number };
  clientErrors: ClientErrorStat[];
}

interface FunnelCounts {
  created: number;
  with_checkin: number;
  connected: number;
  with_user_turn: number;
  with_tool_use: number;
  ended_gracefully: number;
}

interface FunnelData {
  days: number;
  funnel: FunnelCounts;
}

const GROUP_LABELS: Record<string, string> = {
  participant_api: 'Participant API',
  admin_api: 'Admin API',
  ssr: 'SSR pages',
  static: 'Static assets',
};

const FUNNEL_STAGES: Array<{ key: keyof FunnelCounts; label: string }> = [
  { key: 'created', label: 'Session created (consent + start)' },
  { key: 'with_checkin', label: 'Check-in submitted' },
  { key: 'connected', label: 'Connected (realtime attach or chat start)' },
  { key: 'with_user_turn', label: 'First user turn' },
  { key: 'with_tool_use', label: 'Used a tool' },
  { key: 'ended_gracefully', label: 'Ended gracefully' },
];

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return 'N/A';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export default function OpsPanel() {
  const { data: ops, loading: opsLoading, error } = useAdminFetch<OpsData>('/admin/api/analytics/ops');
  // Funnel is best-effort: if it fails, the funnel section is simply omitted.
  const { data: funnel, loading: funnelLoading } = useAdminFetch<FunnelData>('/admin/api/analytics/funnel?days=30');

  if (opsLoading || funnelLoading) {
    return (
      <Panel><p className="text-gray-500 text-center py-4">Loading ops telemetry...</p></Panel>
    );
  }
  if (error || !ops) {
    return (
      <Panel><p className="text-red-600 text-center py-4">{error || 'No ops telemetry available'}</p></Panel>
    );
  }

  const totalRequests = Object.values(ops.requests).reduce((a, b) => a + b, 0);
  const total5xx = Object.values(ops.errorRates).reduce((a, g) => a + g.count_5xx, 0);
  const rate5xx = totalRequests > 0 ? (total5xx / totalRequests) * 100 : 0;
  const apiP95 = ops.latency.participant_api?.p95_ms ?? null;
  const rssMb = Math.round(ops.memory.rss / (1024 * 1024));
  const requestsPerMinute = ops.window_minutes > 0 ? totalRequests / ops.window_minutes : 0;

  const groups = Object.keys(ops.requests);
  const funnelCounts = funnel?.funnel;
  const funnelBase = funnelCounts?.created ?? 0;

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold flex items-center gap-2"><Server size={20} /> Ops Telemetry</h3>
      <p className="text-sm text-gray-600">
        In-process metrics over the last {ops.window_minutes} minutes (reset on deploy).
      </p>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <StatCard label="Request Rate" value={`${requestsPerMinute.toFixed(1)}/min`} sub={`${totalRequests} in window`} icon={Activity} />
        <StatCard label="5xx Rate" value={`${rate5xx.toFixed(2)}%`} sub={`${total5xx} errors`} icon={AlertTriangle} />
        <StatCard label="API p95 Latency" value={formatMs(apiP95)} sub="participant API" icon={Clock} />
        <StatCard label="Memory (RSS)" value={`${rssMb} MB`} icon={Cpu} />
        <StatCard label="Uptime" value={formatUptime(ops.uptime)} icon={Server} />
      </div>

      <Panel title="Requests by Route Group" className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-600 border-b">
              <th className="py-2 pr-4">Group</th>
              <th className="py-2 pr-4">Requests</th>
              <th className="py-2 pr-4">4xx</th>
              <th className="py-2 pr-4">5xx</th>
              <th className="py-2 pr-4">p50</th>
              <th className="py-2 pr-4">p95</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(group => (
              <tr key={group} className="border-b last:border-0">
                <td className="py-2 pr-4">{GROUP_LABELS[group] || group}</td>
                <td className="py-2 pr-4">{ops.requests[group]}</td>
                <td className="py-2 pr-4">{ops.errorRates[group]?.count_4xx ?? 0}</td>
                <td className={`py-2 pr-4 ${(ops.errorRates[group]?.count_5xx ?? 0) > 0 ? 'text-red-600 font-semibold' : ''}`}>
                  {ops.errorRates[group]?.count_5xx ?? 0}
                </td>
                <td className="py-2 pr-4">{formatMs(ops.latency[group]?.p50_ms ?? null)}</td>
                <td className="py-2 pr-4">{formatMs(ops.latency[group]?.p95_ms ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Client Errors (Last 7 Days)" className="overflow-x-auto">
        <p className="text-sm text-gray-600 mb-3">
          Browser-reported failures via the error beacon: WebRTC, mic permission, chat send, uncaught JS.
        </p>
        {ops.clientErrors.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">No client errors reported.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Kind</th>
                <th className="py-2 pr-4">Count</th>
                <th className="py-2 pr-4">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {ops.clientErrors.map(e => (
                <tr key={e.kind} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{e.kind}</td>
                  <td className="py-2 pr-4">{e.count}</td>
                  <td className="py-2 pr-4">{e.last_seen ? new Date(e.last_seen).toLocaleString() : 'N/A'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {funnelCounts && (
        <Panel title={`Session Funnel (Last ${funnel?.days ?? 30} Days)`}>
          <p className="text-sm text-gray-600 mb-4">
            Consent and start through graceful end, derived from session, message, and tool records.
          </p>
          {funnelBase === 0 ? (
            <p className="text-gray-500 text-sm py-2">No sessions in this window.</p>
          ) : (
            <div className="space-y-2">
              {FUNNEL_STAGES.map(stage => {
                const count = funnelCounts[stage.key];
                const pct = funnelBase > 0 ? (count / funnelBase) * 100 : 0;
                return (
                  <div key={stage.key}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700">{stage.label}</span>
                      <span className="text-gray-600">{count} ({pct.toFixed(0)}%)</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded h-4">
                      <div
                        className="bg-[#0047BA] h-4 rounded"
                        style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
