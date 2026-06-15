import { useState, useEffect } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Activity, MessageSquare, Clock, Mic } from "react-feather";

const COLORS = ['#0047BA', '#002E5D', '#BDD6E6', '#8B959E'];

// Filter option constants
const VOICE_OPTIONS = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'cedar', label: 'Cedar' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'marin', label: 'Marin' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' }
];

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es-ES', label: 'Spanish (ES)' },
  { value: 'es-419', label: 'Spanish (LA)' },
  { value: 'fr-FR', label: 'French (FR)' },
  { value: 'fr-CA', label: 'French (CA)' },
  { value: 'pt-BR', label: 'Portuguese (BR)' },
  { value: 'pt-PT', label: 'Portuguese (PT)' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ru', label: 'Russian' }
];

const SESSION_TYPE_OPTIONS = [
  { value: 'realtime', label: 'Realtime' },
  { value: 'chat', label: 'Chat' }
];

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'ended', label: 'Ended' },
  { value: 'archived', label: 'Archived' }
];

const ENDED_BY_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Admin' },
  { value: 'system', label: 'System' }
];

// Reusable MultiSelectFilter component
function MultiSelectFilter({ label, options, selected, onChange }) {
  const handleToggle = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const handleSelectAll = () => {
    onChange(options.map(opt => opt.value));
  };

  const handleClearAll = () => {
    onChange([]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-gray-700">{label}</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSelectAll}
            className="text-xs text-byuRoyal hover:underline"
          >
            All
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            className="text-xs text-gray-500 hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 max-h-32 overflow-y-auto border rounded p-2 bg-gray-50">
        {options.map(option => (
          <label key={option.value} className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() => handleToggle(option.value)}
              className="accent-byuRoyal"
            />
            <span className="text-sm">{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

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
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    voices: [],
    languages: [],
    sessionTypes: [],
    statuses: [],
    endedBy: [],
    crisisFlagged: ''
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

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

      const data = await response.json();
      setAnalytics(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchAnalytics();
    }, 300); // Debounce filter changes

    return () => clearTimeout(timer);
  }, [filters]);

  const formatDuration = (seconds) => {
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
  };

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const setCurrentMonth = () => {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    setFilters(prev => ({
      ...prev,
      startDate: firstDay.toISOString().split('T')[0],
      endDate: lastDay.toISOString().split('T')[0]
    }));
  };

  const handleClearAll = () => {
    setFilters({
      startDate: '',
      endDate: '',
      voices: [],
      languages: [],
      sessionTypes: [],
      statuses: [],
      endedBy: [],
      crisisFlagged: ''
    });
  };

  const handleClearAdvanced = () => {
    setFilters(prev => ({
      ...prev,
      voices: [],
      languages: [],
      sessionTypes: [],
      statuses: [],
      endedBy: [],
      crisisFlagged: ''
    }));
  };

  // Calculate active advanced filter count
  const advancedFilterCount = [
    filters.voices.length > 0,
    filters.languages.length > 0,
    filters.sessionTypes.length > 0,
    filters.statuses.length > 0,
    filters.endedBy.length > 0,
    filters.crisisFlagged !== ''
  ].filter(Boolean).length;

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

  // Top 20 users by session count
  const userSessionData = (analytics.user_sessions || [])
    .sort((a, b) => b.session_count - a.session_count)
    .slice(0, 20)
    .map(item => ({
      username: item.username || `User ${item.userid}`,
      sessions: item.session_count
    }));

  // Time distribution sorted by time order
  const timeDistributionData = (analytics.time_distribution || [])
    .map(item => ({
      name: item.time_period,
      value: item.session_count
    }))
    .sort((a, b) => {
      const order = { 'Morning': 0, 'Afternoon': 1, 'Evening': 2 };
      return order[a.name] - order[b.name];
    });

  // Duration distribution sorted by duration length
  const durationDistributionData = (analytics.duration_distribution || [])
    .map(item => ({
      name: item.duration_category,
      value: item.session_count
    }))
    .sort((a, b) => {
      const order = { 'Short (0-5 min)': 0, 'Medium (5-30 min)': 1, 'Long (30+ min)': 2 };
      return order[a.name] - order[b.name];
    });

  // Duration trend over time (last 30 days)
  const durationTrendData = (analytics.duration_trend || []).reverse().map(item => ({
    date: new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    duration: Math.round(item.avg_duration_seconds / 60) // Convert to minutes
  }));

  // Language distribution data
  const languageDistributionData = (analytics.language_distribution || [])
    .map(item => ({
      language: item.language.toUpperCase(),
      sessions: item.session_count,
      percentage: item.percentage
    }))
    .sort((a, b) => b.sessions - a.sessions);

  // Voice distribution data
  const voiceDistributionData = (analytics.voice_distribution || [])
    .map(item => ({
      voice: item.voice.charAt(0).toUpperCase() + item.voice.slice(1),
      sessions: item.session_count,
      percentage: item.percentage
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const voicePercentage = analytics.breakdown.voice_messages && analytics.breakdown.voice_messages + analytics.breakdown.chat_messages
    ? Math.round((analytics.breakdown.voice_messages / (analytics.breakdown.voice_messages + analytics.breakdown.chat_messages)) * 100)
    : 0;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold">Analytics Dashboard</h2>

      {/* Filters Section */}
      <div className="bg-white p-4 rounded-lg shadow">
        {/* Row 1: Date Filters */}
        <div className="flex flex-wrap gap-4 mb-4">
          <input
            type="date"
            value={filters.startDate}
            onChange={(e) => handleFilterChange('startDate', e.target.value)}
            className="border rounded px-3 py-2"
            placeholder="Start date"
          />
          <input
            type="date"
            value={filters.endDate}
            onChange={(e) => handleFilterChange('endDate', e.target.value)}
            className="border rounded px-3 py-2"
            placeholder="End date"
          />
          <button
            onClick={setCurrentMonth}
            className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy"
          >
            Current Month
          </button>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={`px-4 py-2 rounded font-medium transition-colors ${
              showAdvanced
                ? 'bg-byuRoyal text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Advanced Filters {showAdvanced ? '▲' : '▼'}
            {advancedFilterCount > 0 && (
              <span className="ml-2 bg-white text-byuRoyal px-2 py-0.5 rounded-full text-xs font-bold">
                {advancedFilterCount}
              </span>
            )}
          </button>
          <button
            onClick={handleClearAll}
            className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
          >
            Clear All
          </button>
        </div>

        {/* Row 2: Advanced Filters (Collapsible) */}
        {showAdvanced && (
          <div className="border-t pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
              {/* Voice Filter */}
              <MultiSelectFilter
                label="Voice"
                options={VOICE_OPTIONS}
                selected={filters.voices}
                onChange={(value) => handleFilterChange('voices', value)}
              />

              {/* Language Filter */}
              <MultiSelectFilter
                label="Language"
                options={LANGUAGE_OPTIONS}
                selected={filters.languages}
                onChange={(value) => handleFilterChange('languages', value)}
              />

              {/* Session Type Filter */}
              <MultiSelectFilter
                label="Session Type"
                options={SESSION_TYPE_OPTIONS}
                selected={filters.sessionTypes}
                onChange={(value) => handleFilterChange('sessionTypes', value)}
              />

              {/* Status Filter */}
              <MultiSelectFilter
                label="Status"
                options={STATUS_OPTIONS}
                selected={filters.statuses}
                onChange={(value) => handleFilterChange('statuses', value)}
              />

              {/* Ended By Filter */}
              <MultiSelectFilter
                label="Ended By"
                options={ENDED_BY_OPTIONS}
                selected={filters.endedBy}
                onChange={(value) => handleFilterChange('endedBy', value)}
              />

              {/* Crisis Flagged Filter */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-gray-700">Crisis Flagged</label>
                <div className="flex flex-col gap-2 border rounded p-2 bg-gray-50">
                  <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                    <input
                      type="radio"
                      name="crisisFlagged"
                      value=""
                      checked={filters.crisisFlagged === ''}
                      onChange={(e) => handleFilterChange('crisisFlagged', e.target.value)}
                      className="accent-byuRoyal"
                    />
                    <span className="text-sm">All</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                    <input
                      type="radio"
                      name="crisisFlagged"
                      value="true"
                      checked={filters.crisisFlagged === 'true'}
                      onChange={(e) => handleFilterChange('crisisFlagged', e.target.value)}
                      className="accent-byuRoyal"
                    />
                    <span className="text-sm">Yes</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-100 px-1 rounded">
                    <input
                      type="radio"
                      name="crisisFlagged"
                      value="false"
                      checked={filters.crisisFlagged === 'false'}
                      onChange={(e) => handleFilterChange('crisisFlagged', e.target.value)}
                      className="accent-byuRoyal"
                    />
                    <span className="text-sm">No</span>
                  </label>
                </div>
              </div>
            </div>

            <button
              onClick={handleClearAdvanced}
              className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300 text-sm"
            >
              Clear Advanced Filters
            </button>
          </div>
        )}
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

      {userSessionData.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Top Users by Session Count</h3>
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
        </div>
      )}

      {timeDistributionData.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Session Distribution by Time of Day</h3>
          <div className="grid grid-cols-2 gap-4">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={timeDistributionData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {timeDistributionData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>

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
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {durationDistributionData.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-semibold mb-4">Session Duration Distribution</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={durationDistributionData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {durationDistributionData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        {durationTrendData.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-semibold mb-4">Average Duration Trend (Minutes)</h3>
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
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {languageDistributionData.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-semibold mb-4">Session Count by Language</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={languageDistributionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="language" />
                <YAxis />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-white p-2 border rounded shadow">
                          <p className="font-semibold">{payload[0].payload.language}</p>
                          <p className="text-sm">Sessions: {payload[0].value}</p>
                          <p className="text-sm text-gray-600">{payload[0].payload.percentage}%</p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                <Bar dataKey="sessions" fill="#0047BA" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {voiceDistributionData.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-semibold mb-4">Session Count by Voice</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={voiceDistributionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="voice" angle={-45} textAnchor="end" height={80} />
                <YAxis />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-white p-2 border rounded shadow">
                          <p className="font-semibold">{payload[0].payload.voice}</p>
                          <p className="text-sm">Sessions: {payload[0].value}</p>
                          <p className="text-sm text-gray-600">{payload[0].payload.percentage}%</p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                <Bar dataKey="sessions" fill="#002E5D" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Session Completion Patterns */}
      {analytics.completion_patterns && analytics.completion_patterns.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Session Completion Patterns</h3>
          <div className="grid grid-cols-2 gap-4">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={analytics.completion_patterns.map(item => ({
                    name: item.ended_by.charAt(0).toUpperCase() + item.ended_by.slice(1),
                    value: item.session_count
                  }))}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {analytics.completion_patterns.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>

            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={analytics.completion_patterns.map(item => ({
                ended_by: item.ended_by.charAt(0).toUpperCase() + item.ended_by.slice(1),
                sessions: item.session_count,
                percentage: item.percentage
              }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="ended_by" />
                <YAxis />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-white p-2 border rounded shadow">
                          <p className="font-semibold">Ended by {payload[0].payload.ended_by}</p>
                          <p className="text-sm">Sessions: {payload[0].value}</p>
                          <p className="text-sm text-gray-600">{payload[0].payload.percentage}%</p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Legend />
                <Bar dataKey="sessions" fill="#0047BA" name="Sessions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Session Quality Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {analytics.abandonment_stats && (
          <div className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-lg font-semibold mb-2">Session Abandonment Rate</h3>
            <p className="text-3xl font-bold text-byuNavy mt-2">
              {analytics.abandonment_stats.abandonment_rate_percentage || 0}%
            </p>
            <p className="text-sm text-gray-600 mt-2">
              {analytics.abandonment_stats.abandoned_sessions || 0} abandoned (&lt;1 min) of{' '}
              {analytics.abandonment_stats.completed_sessions || 0} total
            </p>
          </div>
        )}

        {analytics.session_depth && analytics.session_depth.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow col-span-2">
            <h3 className="text-lg font-semibold mb-4">Average Session Depth by User Type</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={analytics.session_depth.map(item => ({
                user_type: item.user_type.charAt(0).toUpperCase() + item.user_type.slice(1),
                avg_messages: parseFloat(item.avg_messages).toFixed(1),
                session_count: item.session_count
              }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="user_type" />
                <YAxis />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-white p-2 border rounded shadow">
                          <p className="font-semibold">{payload[0].payload.user_type} Users</p>
                          <p className="text-sm">Avg Messages: {payload[0].value}</p>
                          <p className="text-sm text-gray-600">{payload[0].payload.session_count} sessions</p>
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
          </div>
        )}
      </div>

      {/* Engagement Metrics */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">Engagement Metrics</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {analytics.engagement_pace && (
            <div className="border rounded p-4">
              <p className="text-sm text-gray-600">Messages Per Minute</p>
              <p className="text-2xl font-bold text-byuNavy mt-1">
                {analytics.engagement_pace.avg_messages_per_minute
                  ? parseFloat(analytics.engagement_pace.avg_messages_per_minute).toFixed(2)
                  : '0.00'}
              </p>
              <p className="text-xs text-gray-500 mt-1">Conversation pace</p>
            </div>
          )}

          {analytics.response_times && (
            <>
              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">Avg Response Time</p>
                <p className="text-2xl font-bold text-byuNavy mt-1">
                  {analytics.response_times.avg_response_time_seconds
                    ? parseFloat(analytics.response_times.avg_response_time_seconds).toFixed(2) + 's'
                    : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">System latency</p>
              </div>

              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">Median Response Time</p>
                <p className="text-2xl font-bold text-byuNavy mt-1">
                  {analytics.response_times.median_response_time_seconds
                    ? parseFloat(analytics.response_times.median_response_time_seconds).toFixed(2) + 's'
                    : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">50th percentile</p>
              </div>

              <div className="border rounded p-4">
                <p className="text-sm text-gray-600">P95 Response Time</p>
                <p className="text-2xl font-bold text-byuNavy mt-1">
                  {analytics.response_times.p95_response_time_seconds
                    ? parseFloat(analytics.response_times.p95_response_time_seconds).toFixed(2) + 's'
                    : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">95th percentile</p>
              </div>
            </>
          )}
        </div>

        {analytics.turn_taking && (
          <div className="mt-4 p-4 border rounded bg-gray-50">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-600">Turn-Taking Ratio</p>
                <p className="text-2xl font-bold text-byuNavy mt-1">
                  {analytics.turn_taking.user_to_assistant_ratio
                    ? parseFloat(analytics.turn_taking.user_to_assistant_ratio).toFixed(2)
                    : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">User : Assistant</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total User Messages</p>
                <p className="text-2xl font-bold text-byuNavy mt-1">
                  {analytics.turn_taking.total_user_messages || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Total Assistant Messages</p>
                <p className="text-2xl font-bold text-byuNavy mt-1">
                  {analytics.turn_taking.total_assistant_messages || 0}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
