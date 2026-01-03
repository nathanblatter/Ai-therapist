import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit2, Check, X } from 'react-feather';
import UserSessionDetail from './UserSessionDetail';

export default function Profile() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [filteredSessions, setFilteredSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Edit states
  const [editingUsername, setEditingUsername] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Filter states
  const [searchTerm, setSearchTerm] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    fetchUserData();
    fetchSessions();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [sessions, searchTerm, startDate, endDate]);

  const fetchUserData = async () => {
    try {
      const response = await fetch('/api/auth/status');
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
          setNewUsername(data.user.username);
        }
      }
    } catch (err) {
      setError('Failed to fetch user data');
    }
  };

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/sessions');
      if (!response.ok) throw new Error('Failed to fetch sessions');
      const data = await response.json();
      setSessions(data);
      setFilteredSessions(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = () => {
    let filtered = [...sessions];

    // Search filter
    if (searchTerm) {
      filtered = filtered.filter(session =>
        session.session_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        session.session_id.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Date filters
    if (startDate) {
      filtered = filtered.filter(session =>
        new Date(session.created_at) >= new Date(startDate)
      );
    }
    if (endDate) {
      filtered = filtered.filter(session =>
        new Date(session.created_at) <= new Date(endDate + 'T23:59:59')
      );
    }

    setFilteredSessions(filtered);
  };

  const handleUpdateUsername = async () => {
    if (!newUsername.trim()) {
      alert('Username cannot be empty');
      return;
    }

    try {
      const response = await fetch(`/api/users/${user.userid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update username');
      }

      setUser({ ...user, username: newUsername });
      setEditingUsername(false);
      alert('Username updated successfully');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUpdatePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      alert('All password fields are required');
      return;
    }

    if (newPassword !== confirmPassword) {
      alert('New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      alert('Password must be at least 6 characters');
      return;
    }

    try {
      const response = await fetch(`/api/users/${user.userid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update password');
      }

      setEditingPassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      alert('Password updated successfully');
    } catch (err) {
      alert(err.message);
    }
  };

  const calculateStatistics = () => {
    if (!sessions.length) {
      return { totalSessions: 0, totalTime: 0, avgDuration: 0, totalMessages: 0, completedSessions: 0 };
    }

    const totalSessions = sessions.length;
    const completedSessions = sessions.filter(s => s.status === 'ended').length;

    let totalSeconds = 0;
    sessions.forEach(session => {
      if (session.created_at && session.ended_at) {
        const duration = (new Date(session.ended_at) - new Date(session.created_at)) / 1000;
        totalSeconds += duration;
      }
    });

    const avgDuration = completedSessions > 0 ? totalSeconds / completedSessions : 0;

    return {
      totalSessions,
      completedSessions,
      totalTime: totalSeconds,
      avgDuration,
      totalMessages: 0 // We don't have message counts in sessions list
    };
  };

  const formatDuration = (seconds) => {
    if (!seconds) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString();
  };

  const stats = calculateStatistics();

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-gray-50 overflow-y-auto">
      {/* Header */}
      <div className="bg-byuNavy text-white p-6">
        <div className="max-w-6xl mx-auto">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 text-byuLightBlue hover:text-white transition mb-4"
          >
            <ArrowLeft size={20} />
            <span>Back to App</span>
          </button>
          <h1 className="text-4xl font-bold">My Profile</h1>
          <p className="text-byuLightBlue mt-2">Manage your account and view your session history</p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 pb-12 space-y-6">
        {/* Account Information Card */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-2xl font-bold text-byuNavy mb-4">Account Information</h2>

          <div className="space-y-4">
            {/* Username */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Username</label>
              {editingUsername ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
                  />
                  <button
                    onClick={handleUpdateUsername}
                    className="bg-green-500 text-white px-3 py-2 rounded hover:bg-green-600 transition"
                  >
                    <Check size={20} />
                  </button>
                  <button
                    onClick={() => {
                      setEditingUsername(false);
                      setNewUsername(user.username);
                    }}
                    className="bg-gray-500 text-white px-3 py-2 rounded hover:bg-gray-600 transition"
                  >
                    <X size={20} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-lg">{user.username}</span>
                  <button
                    onClick={() => setEditingUsername(true)}
                    className="text-byuRoyal hover:text-byuNavy transition"
                  >
                    <Edit2 size={18} />
                  </button>
                </div>
              )}
            </div>

            {/* User ID */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">User ID</label>
              <span className="text-lg text-gray-600">#{user.userid}</span>
            </div>

            {/* Role */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Role</label>
              <span className="px-3 py-1 bg-byuRoyal text-white rounded-full text-sm">
                {user.role}
              </span>
            </div>

            {/* Password Change */}
            <div className="pt-4 border-t">
              {!editingPassword ? (
                <button
                  onClick={() => setEditingPassword(true)}
                  className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy transition"
                >
                  Change Password
                </button>
              ) : (
                <div className="space-y-3">
                  <h3 className="font-semibold text-lg">Change Password</h3>
                  <input
                    type="password"
                    placeholder="Current Password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
                  />
                  <input
                    type="password"
                    placeholder="New Password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
                  />
                  <input
                    type="password"
                    placeholder="Confirm New Password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleUpdatePassword}
                      className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 transition"
                    >
                      Update Password
                    </button>
                    <button
                      onClick={() => {
                        setEditingPassword(false);
                        setCurrentPassword('');
                        setNewPassword('');
                        setConfirmPassword('');
                      }}
                      className="bg-gray-500 text-white px-4 py-2 rounded hover:bg-gray-600 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Session Statistics Card */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-2xl font-bold text-byuNavy mb-4">Session Statistics</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-byuLightBlue bg-opacity-20 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Total Sessions</div>
              <div className="text-3xl font-bold text-byuNavy">{stats.totalSessions}</div>
            </div>
            <div className="bg-byuLightBlue bg-opacity-20 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Completed</div>
              <div className="text-3xl font-bold text-byuNavy">{stats.completedSessions}</div>
            </div>
            <div className="bg-byuLightBlue bg-opacity-20 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Total Time</div>
              <div className="text-3xl font-bold text-byuNavy">{formatDuration(stats.totalTime)}</div>
            </div>
            <div className="bg-byuLightBlue bg-opacity-20 p-4 rounded-lg">
              <div className="text-sm text-gray-600">Avg Duration</div>
              <div className="text-3xl font-bold text-byuNavy">{formatDuration(stats.avgDuration)}</div>
            </div>
          </div>
        </div>

        {/* Session History Card */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-2xl font-bold text-byuNavy mb-4">Session History</h2>

          {/* Filters */}
          <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Search sessions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
            <input
              type="date"
              placeholder="Start Date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
            <input
              type="date"
              placeholder="End Date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-byuRoyal"
            />
          </div>

          {loading && (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading sessions...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error}
            </div>
          )}

          {!loading && !error && filteredSessions.length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500">No sessions found</p>
            </div>
          )}

          {!loading && !error && filteredSessions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-100 border-b">
                    <th className="px-4 py-3 text-left text-sm font-semibold">Session Name</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">Date</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">Status</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((session) => (
                    <tr key={session.session_id} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-3">
                        {session.session_name || (
                          <span className="text-gray-400 italic">
                            {session.status === 'active' ? 'Session Active' : 'Unnamed Session'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {formatDate(session.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          session.status === 'active'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {session.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedSessionId(session.session_id)}
                          className="bg-byuRoyal text-white px-3 py-1 rounded hover:bg-byuNavy transition text-sm"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Session Detail Modal */}
      {selectedSessionId && (
        <UserSessionDetail
          sessionId={selectedSessionId}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
    </div>
  );
}
