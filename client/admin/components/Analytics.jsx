import { useState, useEffect } from "react";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Activity, MessageSquare, Clock, Mic } from "react-feather";

const COLORS = ['#0047BA', '#002E5D', '#BDD6E6', '#8B959E'];

function MetricCard({ title, value, icon: Icon }) {
  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">{title}</p>
          <p className="text-3xl font-bold text-byuNavy mt-2">{value}</p>
        </div>
        <div className="bg-byuLightBlue p-3 rounded-full">
          <Icon size={24} className="text-byuNavy" />
        </div>
      </div>
    </div>
  );
}

export default function Analytics() {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateRange, setDateRange] = useState({ startDate: '', endDate: '' });

  const fetchAnalytics = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams(
        Object.fromEntries(
          Object.entries(dateRange).filter(([_, v]) => v !== '')
        )
      );

      const response = await fetch(`/admin/api/analytics?${params}`);
      if (!response.ok) throw new Error('Failed to fetch analytics');

      const data = await response.json();
      setAnalytics(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [dateRange]);

  const formatDuration = (seconds) => {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    return `${mins}m`;
  };

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-gray-500 text-center py-8">Loading analytics...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      </div>
    );
  }

  if (!analytics || !analytics.metrics) {
    return (
      <div className="p-6">
        <p className="text-gray-500 text-center py-8">No analytics data available</p>
      </div>
    );
  }

  const messageTypeData = [
    { name: 'Voice', value: analytics.breakdown.voice_messages || 0 },
    { name: 'Chat', value: analytics.breakdown.chat_messages || 0 }
  ];

  const roleData = [
    { name: 'User', value: analytics.breakdown.user_messages || 0 },
    { name: 'Assistant', value: analytics.breakdown.assistant_messages || 0 }
  ];

  const dailyTrendData = (analytics.daily_trend || []).reverse().map(item => ({
    date: new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    sessions: item.session_count
  }));

  const voicePercentage = analytics.breakdown.voice_messages && analytics.breakdown.voice_messages + analytics.breakdown.chat_messages
    ? Math.round((analytics.breakdown.voice_messages / (analytics.breakdown.voice_messages + analytics.breakdown.chat_messages)) * 100)
    : 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Analytics Dashboard</h2>
        <div className="flex gap-2">
          <input
            type="date"
            value={dateRange.startDate}
            onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
            className="border rounded px-3 py-2"
          />
          <input
            type="date"
            value={dateRange.endDate}
            onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
            className="border rounded px-3 py-2"
          />
          <button
            onClick={() => setDateRange({ startDate: '', endDate: '' })}
            className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          title="Total Sessions"
          value={analytics.metrics.total_sessions || 0}
          icon={Activity}
        />
        <MetricCard
          title="Avg Messages"
          value={(analytics.metrics.avg_messages_per_session || 0).toFixed(1)}
          icon={MessageSquare}
        />
        <MetricCard
          title="Avg Duration"
          value={formatDuration(analytics.metrics.avg_duration_seconds)}
          icon={Clock}
        />
        <MetricCard
          title="Voice Usage"
          value={`${voicePercentage}%`}
          icon={Mic}
        />
      </div>

      {dailyTrendData.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Session Activity (Last 30 Days)</h3>
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
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Message Type Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={messageTypeData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {messageTypeData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Role Distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={roleData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {roleData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
