import { useState, useEffect } from 'react';
import { AlertCircle, RefreshCw, Clock, User } from 'react-feather';

export default function RateLimitedUsers() {
  const [rateLimitedUsers, setRateLimitedUsers] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/admin/api/rate-limits/users');
      if (!response.ok) throw new Error('Failed to fetch rate-limited users');

      const data = await response.json();
      setRateLimitedUsers(data.rateLimitedUsers);
      setConfig(data.config);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);

    return () => clearInterval(interval);
  }, []);

  const formatResetTime = (hoursUntilReset) => {
    if (!hoursUntilReset) return 'less than 1 hour';
    const hours = Math.floor(hoursUntilReset);
    const minutes = Math.round((hoursUntilReset - hours) * 60);
    if (hours === 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    return `${hours} hour${hours !== 1 ? 's' : ''}, ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  };

  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  };

  if (loading && !rateLimitedUsers.length) {
    return (
      <div className="flex justify-center items-center h-96">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-byuNavy">Rate-Limited Users</h1>
          <p className="text-gray-600 mt-1">
            Users who have reached their daily session limit
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 px-4 py-2 bg-byuRoyal text-white rounded-lg hover:bg-byuNavy transition"
          disabled={loading}
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      )}

      {/* Config Info Card */}
      {config && (
        <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg">
          <h3 className="font-semibold text-blue-900 mb-2">Current Rate Limit Settings</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-blue-700 font-medium">Max Sessions/Day:</span>
              <span className="ml-2 text-blue-900">{config.max_sessions_per_day}</span>
            </div>
            <div>
              <span className="text-blue-700 font-medium">Max Duration:</span>
              <span className="ml-2 text-blue-900">{config.max_duration_minutes} minutes</span>
            </div>
            <div>
              <span className="text-blue-700 font-medium">Cooldown:</span>
              <span className="ml-2 text-blue-900">{config.cooldown_minutes} minutes</span>
            </div>
          </div>
        </div>
      )}

      {/* Last Refresh Time */}
      {lastRefresh && (
        <div className="text-sm text-gray-500">
          Last updated: {lastRefresh.toLocaleTimeString()}
        </div>
      )}

      {/* Rate Limited Users Table */}
      {rateLimitedUsers.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <AlertCircle size={48} className="mx-auto text-gray-400 mb-4" />
          <h3 className="text-xl font-semibold text-gray-700 mb-2">
            No users are currently rate-limited
          </h3>
          <p className="text-gray-500">
            All users are within their daily session limits.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="px-6 py-4 bg-gray-50 border-b">
            <h3 className="font-semibold text-gray-800">
              Rate-Limited Users ({rateLimitedUsers.length})
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <div className="flex items-center gap-2">
                      <User size={14} />
                      Username
                    </div>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sessions Used
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last Session
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <div className="flex items-center gap-2">
                      <Clock size={14} />
                      Resets In
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {rateLimitedUsers.map((user) => (
                  <tr key={user.userid} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="text-sm font-medium text-gray-900">
                          {user.username}
                        </div>
                        <div className="text-sm text-gray-500 ml-2">
                          #{user.userid}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        <span className="font-semibold text-red-600">
                          {user.sessions_used_today}
                        </span>
                        <span className="text-gray-500"> / {user.session_limit}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatTimeAgo(user.last_session_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-yellow-600">
                        {formatResetTime(user.hours_until_reset)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Info Note */}
      <div className="text-sm text-gray-500 bg-gray-50 p-4 rounded border border-gray-200">
        <p>
          <strong>Note:</strong> Limits reset at midnight Salt Lake City time (America/Denver timezone).
          Researcher accounts are exempt from rate limits and will not appear in this list.
        </p>
      </div>
    </div>
  );
}
