import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Tool, Activity, AlertTriangle } from 'react-feather';
import useAdminFetch from '../../hooks/useAdminFetch';
import Panel from '../ui/Panel';
import StatCard from '../ui/StatCard';

// Tool usage analytics (ai-therapist-75), extracted from Analytics.tsx into
// the Tools tab (ai-therapist-120). Fetches lazily: mounting only happens
// when the tab is opened.

interface ToolStat {
  tool_name: string;
  invocations: number;
  sessions: number;
  last_used: string | null;
  failures: number;
  failure_rate: number;
}

interface ToolsPerSessionBucket {
  distinct_tool_count: number;
  session_count: number;
}

interface ToolAnalyticsData {
  tool_stats: ToolStat[];
  distinct_tools_per_session: ToolsPerSessionBucket[];
  dead_tools: string[];
  registered_tool_count: number;
  sessions_with_tool_use: number;
  total_sessions: number;
}

export default function ToolUsagePanel() {
  const { data, loading, error } = useAdminFetch<ToolAnalyticsData>('/admin/api/analytics/tools');

  if (loading) {
    return (
      <Panel><p className="text-gray-500 text-center py-4">Loading tool usage...</p></Panel>
    );
  }
  if (error || !data) {
    return (
      <Panel><p className="text-red-600 text-center py-4">{error || 'No tool analytics available'}</p></Panel>
    );
  }

  const frequencyData = data.tool_stats.map(t => ({
    tool: t.tool_name,
    invocations: t.invocations,
  }));

  const distributionData = data.distinct_tools_per_session.map(b => ({
    name: b.distinct_tool_count === 0 ? '0 tools' : `${b.distinct_tool_count} tool${b.distinct_tool_count === 1 ? '' : 's'}`,
    sessions: b.session_count,
  }));

  const toolUsePercentage = data.total_sessions > 0
    ? Math.round((data.sessions_with_tool_use / data.total_sessions) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold flex items-center gap-2"><Tool size={20} /> Tool Usage Analytics</h3>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Registered Tools" value={data.registered_tool_count} icon={Tool} />
        <StatCard label="Sessions Using a Tool" value={`${toolUsePercentage}%`} icon={Activity} />
        <StatCard label="Dead Tools (never fired)" value={data.dead_tools.length} icon={AlertTriangle} />
      </div>

      {data.dead_tools.length > 0 && (
        <Panel title="Dead Tools">
          <p className="text-sm text-gray-600 mb-3">Registered in the tool registry but never invoked in any logged session.</p>
          <div className="flex flex-wrap gap-2">
            {data.dead_tools.map(name => (
              <span key={name} className="font-mono text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">
                {name}
              </span>
            ))}
          </div>
        </Panel>
      )}

      {frequencyData.length > 0 && (
        <Panel title="Tool-Call Frequency">
          <ResponsiveContainer width="100%" height={Math.max(300, frequencyData.length * 28)}>
            <BarChart data={frequencyData} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" />
              <YAxis type="category" dataKey="tool" width={220} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="invocations" fill="#0047BA" name="Invocations" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {distributionData.length > 0 && (
        <Panel title="Distinct Tools Used Per Session">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={distributionData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="sessions" fill="#002E5D" name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {data.tool_stats.length > 0 && (
        <Panel title="Failure / Misfire Rates" className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Tool</th>
                <th className="py-2 pr-4">Invocations</th>
                <th className="py-2 pr-4">Sessions</th>
                <th className="py-2 pr-4">Failures</th>
                <th className="py-2 pr-4">Failure Rate</th>
                <th className="py-2 pr-4">Last Used</th>
              </tr>
            </thead>
            <tbody>
              {data.tool_stats
                .slice()
                .sort((a, b) => b.failure_rate - a.failure_rate)
                .map(t => (
                  <tr key={t.tool_name} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{t.tool_name}</td>
                    <td className="py-2 pr-4">{t.invocations}</td>
                    <td className="py-2 pr-4">{t.sessions}</td>
                    <td className="py-2 pr-4">{t.failures}</td>
                    <td className={`py-2 pr-4 ${t.failure_rate > 10 ? 'text-red-600 font-semibold' : ''}`}>
                      {t.failure_rate}%
                    </td>
                    <td className="py-2 pr-4 text-gray-500">
                      {t.last_used ? new Date(t.last_used).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
