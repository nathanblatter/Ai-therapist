import { useState, useEffect } from 'react';
import { Clock, User, Calendar, RefreshCw, Trash2 } from 'react-feather';
import { toast } from '../../shared/components/Toast';

export default function UserSessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('expire'); // 'expire', 'username', 'created'
  const [sortOrder, setSortOrder] = useState('asc'); // 'asc' or 'desc'

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/api/user-sessions', {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to fetch user sessions');
      }

      const data = await response.json();
      setSessions(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteSessions = async (sid) => {
    if (!confirm('Are you sure you want to delete this session? The user will be logged out.')) {
      return;
    }

    try {
      const response = await fetch(`/admin/api/user-sessions/${sid}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to delete session');
      }

      // Refresh the sessions list
      fetchSessions();
    } catch (err) {
      toast.error(`Error: ${err.message}`);
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatTimeRemaining = (expireDate) => {
    const now = new Date();
    const expire = new Date(expireDate);
    const diff = expire - now;

    if (diff < 0) {
      return <span className="text-red-600 font-semibold">Expired</span>;
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return <span className="text-green-600">{days}d {hours % 24}h</span>;
    }

    return <span className="text-yellow-600">{hours}h {minutes}m</span>;
  };

  const sortedSessions = [...sessions].sort((a, b) => {
    let compareValue = 0;

    if (sortBy === 'expire') {
      compareValue = new Date(a.expire) - new Date(b.expire);
    } else if (sortBy === 'username') {
      compareValue = (a.username || '').localeCompare(b.username || '');
    } else if (sortBy === 'created') {
      const aCreated = a.cookie?.expires ? new Date(a.cookie.expires).getTime() - (a.cookie.originalMaxAge || 0) : 0;
      const bCreated = b.cookie?.expires ? new Date(b.cookie.expires).getTime() - (b.cookie.originalMaxAge || 0) : 0;
      compareValue = aCreated - bCreated;
    }

    return sortOrder === 'asc' ? compareValue : -compareValue;
  });

  const toggleSort = (field) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500">Loading user sessions...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-byuNavy">Active User Sessions</h1>
          <p className="text-gray-600 mt-1">
            Monitor and manage active login sessions
          </p>
        </div>
        <button
          onClick={fetchSessions}
          className="flex items-center gap-2 bg-byuRoyal text-white px-4 py-2 rounded-lg hover:bg-byuNavy transition"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Sessions</p>
              <p className="text-2xl font-bold text-byuNavy">{sessions.length}</p>
            </div>
            <User className="text-byuRoyal" size={32} />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Sessions</p>
              <p className="text-2xl font-bold text-green-600">
                {sessions.filter(s => new Date(s.expire) > new Date()).length}
              </p>
            </div>
            <Clock className="text-green-500" size={32} />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Expired Sessions</p>
              <p className="text-2xl font-bold text-red-600">
                {sessions.filter(s => new Date(s.expire) <= new Date()).length}
              </p>
            </div>
            <Calendar className="text-red-500" size={32} />
          </div>
        </div>
      </div>

      {/* Sessions Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => toggleSort('username')}
                >
                  <div className="flex items-center gap-2">
                    User
                    {sortBy === 'username' && (
                      <span>{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User ID
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => toggleSort('expire')}
                >
                  <div className="flex items-center gap-2">
                    Expires
                    {sortBy === 'expire' && (
                      <span>{sortOrder === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Time Remaining
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Session ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Cookie Settings
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedSessions.map((session) => (
                <tr key={session.sid} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <User size={16} className="text-gray-400" />
                      <span className="font-medium text-gray-900">
                        {session.username || 'N/A'}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`px-2 py-1 text-xs rounded-full ${
                      session.userRole === 'researcher'
                        ? 'bg-purple-100 text-purple-800'
                        : session.userRole === 'admin'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-gray-100 text-gray-800'
                    }`}>
                      {session.userRole || 'N/A'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    #{session.userId || 'N/A'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    {formatDate(session.expire)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {formatTimeRemaining(session.expire)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-700">
                      {session.sid.substring(0, 12)}...
                    </code>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-xs text-gray-600 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">Secure:</span>
                        <span className={session.cookie?.secure ? 'text-green-600' : 'text-red-600'}>
                          {session.cookie?.secure ? 'Yes' : 'No'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">HttpOnly:</span>
                        <span className={session.cookie?.httpOnly ? 'text-green-600' : 'text-red-600'}>
                          {session.cookie?.httpOnly ? 'Yes' : 'No'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">SameSite:</span>
                        <span>{session.cookie?.sameSite || 'N/A'}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <button
                      onClick={() => deleteSessions(session.sid)}
                      className="text-red-600 hover:text-red-800 transition"
                      title="Delete session (logout user)"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {sessions.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No active user sessions found</p>
        </div>
      )}
    </div>
  );
}
