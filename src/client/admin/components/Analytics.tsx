import { useState, useEffect } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { PieLabelRenderProps } from "recharts";
import type { TooltipContentProps } from "recharts";
import type { ValueType, NameType } from "recharts/types/component/DefaultTooltipContent";
import { Activity, MessageSquare, Clock, Mic } from "react-feather";
import OpsPanel from "./OpsPanel";
import Panel from "./ui/Panel";
import StatCard from "./ui/StatCard";
import AnalyticsFilterBar, { EMPTY_FILTERS } from "./analytics/AnalyticsFilterBar";
import ToolUsagePanel from "./analytics/ToolUsagePanel";
import CostUsagePanel from "./analytics/CostUsagePanel";
import type { AnalyticsData, AnalyticsFilterState } from "./analytics/types";

const COLORS = ['#0047BA', '#002E5D', '#BDD6E6', '#8B959E'];

// Format a millisecond metric as seconds (values arrive as numeric strings
// from row_to_json / PERCENTILE_CONT).
function formatMs(v: string | number | null | undefined): string {
  if (v == null) return 'N/A';
  const n = parseFloat(String(v));
  if (!Number.isFinite(n)) return 'N/A';
  return (n / 1000).toFixed(2) + 's';
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return '0s';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else if (mins > 0) {
    return `${mins}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// Pie with percentage labels and palette cells — the shape every distribution
// section on this page uses.
function DistPie({ data, outerRadius = 100, legend = true }: {
  data: Array<{ name: string; value: number }>;
  outerRadius?: number;
  legend?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          labelLine={false}
          label={({ name, percent }: PieLabelRenderProps) => `${String(name ?? '')}: ${((Number(percent ?? 0)) * 100).toFixed(0)}%`}
          outerRadius={outerRadius}
          fill="#8884d8"
          dataKey="value"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip />
        {legend && <Legend />}
      </PieChart>
    </ResponsiveContainer>
  );
}

// Custom bar tooltip: bold title, session count, percentage line.
function pctTooltip(nameKey: string, titlePrefix = '') {
  return function PctTooltip(props: TooltipContentProps<ValueType, NameType>) {
    const { active, payload } = props;
    if (!active || !payload || !payload.length) return null;
    const entry = payload[0].payload as Record<string, string | number>;
    return (
      <div className="bg-white p-2 border rounded shadow">
        <p className="font-semibold">{titlePrefix}{String(entry[nameKey])}</p>
        <p className="text-sm">Sessions: {payload[0].value}</p>
        <p className="text-sm text-gray-600">{entry.percentage}%</p>
      </div>
    );
  };
}

// ---- Usage tab: KPIs + distribution charts + completion + quality ----

function UsageTab({ analytics }: { analytics: AnalyticsData }) {
  const messageTypeData = [
    { name: 'Voice', value: analytics.breakdown.voice_messages || 0 },
    { name: 'Chat', value: analytics.breakdown.chat_messages || 0 }
  ];

  const roleData = [
    { name: 'User', value: analytics.breakdown.user_messages || 0 },
    { name: 'Assistant', value: analytics.breakdown.assistant_messages || 0 }
  ];

  const dailyTrendData = (analytics.daily_trend || []).slice().reverse().map(item => ({
    date: new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    sessions: item.session_count
  }));

  // Top 20 users by session count
  const userSessionData = (analytics.user_sessions || [])
    .slice()
    .sort((a, b) => b.session_count - a.session_count)
    .slice(0, 20)
    .map(item => ({
      username: item.username || `User ${item.userid}`,
      sessions: item.session_count
    }));

  // Time distribution sorted by time order
  const timeOrder: Record<string, number> = { 'Morning': 0, 'Afternoon': 1, 'Evening': 2 };
  const timeDistributionData = (analytics.time_distribution || [])
    .map(item => ({ name: item.time_period, value: item.session_count }))
    .sort((a, b) => (timeOrder[a.name] ?? 99) - (timeOrder[b.name] ?? 99));

  // Duration distribution sorted by duration length
  const durationOrder: Record<string, number> = { 'Short (0-5 min)': 0, 'Medium (5-30 min)': 1, 'Long (30+ min)': 2 };
  const durationDistributionData = (analytics.duration_distribution || [])
    .map(item => ({ name: item.duration_category, value: item.session_count }))
    .sort((a, b) => (durationOrder[a.name] ?? 99) - (durationOrder[b.name] ?? 99));

  // Duration trend over time (last 30 days)
  const durationTrendData = (analytics.duration_trend || []).slice().reverse().map(item => ({
    date: new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    duration: Math.round(item.avg_duration_seconds / 60) // Convert to minutes
  }));

  const languageDistributionData = (analytics.language_distribution || [])
    .map(item => ({
      language: item.language.toUpperCase(),
      sessions: item.session_count,
      percentage: item.percentage
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const voiceDistributionData = (analytics.voice_distribution || [])
    .map(item => ({
      voice: item.voice.charAt(0).toUpperCase() + item.voice.slice(1),
      sessions: item.session_count,
      percentage: item.percentage
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const completionPieData = (analytics.completion_patterns || []).map(item => ({
    name: item.ended_by.charAt(0).toUpperCase() + item.ended_by.slice(1),
    value: item.session_count
  }));

  const completionBarData = (analytics.completion_patterns || []).map(item => ({
    ended_by: item.ended_by.charAt(0).toUpperCase() + item.ended_by.slice(1),
    sessions: item.session_count,
    percentage: item.percentage
  }));

  const voicePercentage = analytics.breakdown.voice_messages && analytics.breakdown.voice_messages + analytics.breakdown.chat_messages
    ? Math.round((analytics.breakdown.voice_messages / (analytics.breakdown.voice_messages + analytics.breakdown.chat_messages)) * 100)
    : 0;

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Total Sessions" value={analytics.metrics.total_sessions || 0} icon={Activity} />
        <StatCard label="Avg Messages" value={(analytics.metrics.avg_messages_per_session || 0).toFixed(1)} icon={MessageSquare} />
        <StatCard label="Avg Duration" value={formatDuration(analytics.metrics.avg_duration_seconds)} icon={Clock} />
        <StatCard label="Voice Usage" value={`${voicePercentage}%`} icon={Mic} />
      </div>

      {dailyTrendData.length > 0 && (
        <Panel title="Session Activity (Last 30 Days)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={dailyTrendData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="sessions" fill="#0047BA" name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Message Type Distribution">
          <DistPie data={messageTypeData} outerRadius={80} legend={false} />
        </Panel>
        <Panel title="Role Distribution">
          <DistPie data={roleData} outerRadius={80} legend={false} />
        </Panel>
      </div>

      {userSessionData.length > 0 && (
        <Panel title="Top Users by Session Count">
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={userSessionData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="username" angle={-45} textAnchor="end" height={100} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="sessions" fill="#0047BA" name="Sessions" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {timeDistributionData.length > 0 && (
        <Panel title="Session Distribution by Time of Day">
          <div className="grid grid-cols-2 gap-4">
            <DistPie data={timeDistributionData} />
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={timeDistributionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="value" fill="#002E5D" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-4">
        {durationDistributionData.length > 0 && (
          <Panel title="Session Duration Distribution">
            <DistPie data={durationDistributionData} />
          </Panel>
        )}

        {durationTrendData.length > 0 && (
          <Panel title="Average Duration Trend (Minutes)">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={durationTrendData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="duration" stroke="#0047BA" strokeWidth={2} name="Avg Duration (min)" />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {languageDistributionData.length > 0 && (
          <Panel title="Session Count by Language">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={languageDistributionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="language" />
                <YAxis />
                <Tooltip content={pctTooltip('language')} />
                <Legend />
                <Bar dataKey="sessions" fill="#0047BA" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}

        {voiceDistributionData.length > 0 && (
          <Panel title="Session Count by Voice">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={voiceDistributionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="voice" angle={-45} textAnchor="end" height={80} />
                <YAxis />
                <Tooltip content={pctTooltip('voice')} />
                <Legend />
                <Bar dataKey="sessions" fill="#002E5D" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}
      </div>

      {completionPieData.length > 0 && (
        <Panel title="Session Completion Patterns">
          <div className="grid grid-cols-2 gap-4">
            <DistPie data={completionPieData} />
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={completionBarData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="ended_by" />
                <YAxis />
                <Tooltip content={pctTooltip('ended_by', 'Ended by ')} />
                <Legend />
                <Bar dataKey="sessions" fill="#0047BA" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      {/* Session Quality Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {analytics.abandonment_stats && (
          <Panel title="Session Abandonment Rate">
            <p className="text-3xl font-bold text-navy mt-2">
              {analytics.abandonment_stats.abandonment_rate_percentage || 0}%
            </p>
            <p className="text-sm text-gray-600 mt-2">
              {analytics.abandonment_stats.abandoned_sessions || 0} abandoned (&lt;1 min) of{' '}
              {analytics.abandonment_stats.completed_sessions || 0} total
            </p>
          </Panel>
        )}

        {analytics.session_depth && analytics.session_depth.length > 0 && (
          <Panel title="Average Session Depth by User Type" className="col-span-2">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={analytics.session_depth.map(item => ({
                user_type: item.user_type.charAt(0).toUpperCase() + item.user_type.slice(1),
                avg_messages: parseFloat(String(item.avg_messages)).toFixed(1),
                session_count: item.session_count
              }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="user_type" />
                <YAxis />
                <Tooltip
                  content={(props: TooltipContentProps<ValueType, NameType>) => {
                    const { active, payload } = props;
                    if (active && payload && payload.length) {
                      const entry = payload[0].payload as { user_type: string; session_count: number };
                      return (
                        <div className="bg-white p-2 border rounded shadow">
                          <p className="font-semibold">{entry.user_type} Users</p>
                          <p className="text-sm">Avg Messages: {payload[0].value}</p>
                          <p className="text-sm text-gray-600">{entry.session_count} sessions</p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                <Bar dataKey="avg_messages" fill="#002E5D" name="Avg Messages" />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}
      </div>
    </>
  );
}

// ---- Performance tab: engagement/latency tile wall + ops telemetry ----

function PerformanceTab({ analytics }: { analytics: AnalyticsData }) {
  return (
    <>
      <Panel title="Engagement Metrics">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {analytics.engagement_pace && (
            <div className="border rounded p-4">
              <p className="text-sm text-gray-600">Messages Per Minute</p>
              <p className="text-2xl font-bold text-navy mt-1">
                {analytics.engagement_pace.avg_messages_per_minute
                  ? parseFloat(String(analytics.engagement_pace.avg_messages_per_minute)).toFixed(2)
                  : '0.00'}
              </p>
              <p className="text-xs text-gray-500 mt-1">Conversation pace</p>
            </div>
          )}

          {analytics.response_times && (
            <>
              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">Time to First Audio (p50)</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {formatMs(analytics.response_times.p50_ttfa_ms)}
                </p>
                <p className="text-xs text-gray-500 mt-1">Measured turn latency, median</p>
              </div>

              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">Time to First Audio (p95)</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {formatMs(analytics.response_times.p95_ttfa_ms)}
                </p>
                <p className="text-xs text-gray-500 mt-1">95th percentile</p>
              </div>

              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">Total Turn Time (p50 / p95)</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {formatMs(analytics.response_times.p50_total_ms)}
                  {' / '}
                  {formatMs(analytics.response_times.p95_total_ms)}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  User turn end to response done ({analytics.response_times.measured_turns || 0} turns measured, realtime only)
                </p>
              </div>
            </>
          )}
        </div>

        {analytics.chat_response_times && (analytics.chat_response_times.measured_turns || 0) > 0 && (
          <p className="text-xs text-gray-500 mt-3">
            Chat turn time (p50 / p95): {formatMs(analytics.chat_response_times.p50_total_ms)}
            {' / '}
            {formatMs(analytics.chat_response_times.p95_total_ms)}
            {' '}({analytics.chat_response_times.measured_turns} chat turns; full tool-loop wall time, not comparable to realtime TTFA)
          </p>
        )}

        {analytics.sideband_reliability && (
          <div className="mt-4 p-4 border rounded bg-gray-50">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-600">Sideband Attach Success (7d)</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {analytics.sideband_reliability.attach_success_rate != null
                    ? parseFloat(String(analytics.sideband_reliability.attach_success_rate)).toFixed(1) + '%'
                    : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {analytics.sideband_reliability.attached_sessions || 0} of{' '}
                  {analytics.sideband_reliability.realtime_sessions || 0} realtime sessions attached
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Realtime Sessions (7d)</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {analytics.sideband_reliability.realtime_sessions || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Sessions with Sideband Errors (7d)</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {analytics.sideband_reliability.error_sessions || 0}
                </p>
              </div>
            </div>
          </div>
        )}

        {analytics.turn_taking && (
          <div className="mt-4 p-4 border rounded bg-gray-50">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-600">Turn-Taking Ratio</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {analytics.turn_taking.user_to_assistant_ratio
                    ? parseFloat(String(analytics.turn_taking.user_to_assistant_ratio)).toFixed(2)
                    : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">User : Assistant</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total User Messages</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {analytics.turn_taking.total_user_messages || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Assistant Messages</p>
                <p className="text-2xl font-bold text-navy mt-1">
                  {analytics.turn_taking.total_assistant_messages || 0}
                </p>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <OpsPanel />
    </>
  );
}

// ---- Main dashboard: tabbed (ai-therapist-120) ----
// Only the active tab is rendered, so the Cost/Tools/Ops panels' own fetches
// fire lazily when their tab is first opened. The main /admin/api/analytics
// fetch keeps its original behavior (fires on mount, debounced on filters).

const TABS = [
  { id: 'usage', label: 'Usage' },
  { id: 'performance', label: 'Performance' },
  { id: 'cost', label: 'Cost' },
  { id: 'tools', label: 'Tools' },
] as const;
type TabId = typeof TABS[number]['id'];

export default function Analytics() {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AnalyticsFilterState>(EMPTY_FILTERS);
  const [tab, setTab] = useState<TabId>('usage');

  useEffect(() => {
    const fetchAnalytics = async () => {
      setLoading(true);
      setError(null);

      try {
        // Serialize filters for URL params
        const params = new URLSearchParams();

        if (filters.startDate) params.append('startDate', filters.startDate);
        if (filters.endDate) params.append('endDate', filters.endDate);
        if (filters.voices.length > 0) params.append('voices', filters.voices.join(','));
        if (filters.languages.length > 0) params.append('languages', filters.languages.join(','));
        if (filters.sessionTypes.length > 0) params.append('sessionTypes', filters.sessionTypes.join(','));
        if (filters.statuses.length > 0) params.append('statuses', filters.statuses.join(','));
        if (filters.endedBy.length > 0) params.append('endedBy', filters.endedBy.join(','));
        if (filters.crisisFlagged) params.append('crisisFlagged', filters.crisisFlagged);

        const response = await fetch(`/admin/api/analytics?${params}`);
        if (!response.ok) throw new Error('Failed to fetch analytics');

        const data: AnalyticsData = await response.json();
        setAnalytics(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    const timer = setTimeout(() => {
      fetchAnalytics();
    }, 300); // Debounce filter changes

    return () => clearTimeout(timer);
  }, [filters]);

  // Loading / error / empty gate for the tabs that depend on the main fetch.
  const mainStatus = loading ? (
    <p className="text-gray-500 text-center py-8">Loading analytics...</p>
  ) : error ? (
    <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
      Error: {error}
    </div>
  ) : (!analytics || !analytics.metrics) ? (
    <p className="text-gray-500 text-center py-8">No analytics data available</p>
  ) : null;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold">Analytics</h2>

      <div className="flex gap-1 border-b" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.id
                ? 'border-royal text-royal'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'usage' && (
        <>
          <AnalyticsFilterBar filters={filters} onChange={setFilters} />
          {mainStatus || (analytics && <UsageTab analytics={analytics} />)}
        </>
      )}
      {tab === 'performance' && (mainStatus || (analytics && <PerformanceTab analytics={analytics} />))}
      {tab === 'cost' && <CostUsagePanel />}
      {tab === 'tools' && <ToolUsagePanel />}
    </div>
  );
}
