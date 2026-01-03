import { useState, useEffect } from 'react';
import { Activity, Users, MessageSquare } from 'react-feather';
import { useSocket } from '../hooks/useSocket';

export default function LiveMonitoring({ onViewSession }) {
  const [activeSessions, setActiveSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { socket, connected } = useSocket();

  // Initial fetch
  useEffect(() => {
    fetchActiveSessions();
  }, []);

  // Socket.io real-time listeners
  useEffect(() => {
    if (!socket) return;

    socket.on('session:created', handleSessionCreated);
    socket.on('session:ended', handleSessionEnded);
    socket.on('session:activity', handleSessionActivity);

    return () => {
      socket.off('session:created', handleSessionCreated);
      socket.off('session:ended', handleSessionEnded);
      socket.off('session:activity', handleSessionActivity);
    };
  }, [socket]);

  const fetchActiveSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/api/sessions/active');
      if (!response.ok) throw new Error('Failed to fetch active sessions');
      const data = await response.json();
      // Parse numeric fields to ensure they're numbers, not strings
      const sessions = (data.sessions || []).map(session => ({
        ...session,
        message_count: parseInt(session.message_count) || 0,
        duration_seconds: parseFloat(session.duration_seconds) || 0
      }));
      setActiveSessions(sessions);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSessionCreated = (data) => {
    setActiveSessions(prev => [{
      session_id: data.sessionId,
      user_id: data.userId,
      username: data.username,
      session_name: null,
      status: data.status,
      created_at: data.created_at,
      message_count: 0,
      last_activity: data.created_at,
      duration_seconds: 0
    }, ...prev]);
  };

  const handleSessionEnded = (data) => {
    setActiveSessions(prev =>
      prev.filter(s => s.session_id !== data.sessionId)
    );
  };

  const handleSessionActivity = (data) => {
    setActiveSessions(prev =>
      prev.map(session =>
        session.session_id === data.sessionId
          ? {
              ...session,
              message_count: parseInt(session.message_count || 0) + parseInt(data.messageCount || 0),
              last_activity: data.lastActivity
            }
          : session
      )
    );
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const getTimeSince = (timestamp) => {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((Date.now() - new Date(timestamp)) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  const handleEndSession = async (sessionId, username) => {
    const confirmMessage = `Are you sure you want to remotely end ${username || 'this user'}'s session?\n\nThis will:\n- Terminate the active therapy session\n- Disconnect the user from the AI assistant\n- Save all messages to the database`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      const response = await fetch(`/admin/api/sessions/${sessionId}/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to end session');
      }

      const data = await response.json();
      console.log('Session ended successfully:', data);

      // Session will be removed via Socket.io event, no need to update state manually
    } catch (err) {
      console.error('Failed to end session:', err);
      alert(`Failed to end session: ${err.message}`);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-byuNavy">Live Session Monitoring</h2>
          <p className="text-gray-600 mt-1">
            Real-time view of active therapy sessions
            {connected && <span className="ml-2 text-green-600">● Connected</span>}
            {!connected && <span className="ml-2 text-red-600">● Disconnected</span>}
          </p>
        </div>
        <button
          onClick={fetchActiveSessions}
          className="px-4 py-2 bg-byuRoyal text-white rounded hover:bg-byuNavy transition"
        >
          Refresh
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Sessions</p>
              <p className="text-3xl font-bold text-byuNavy mt-1">{activeSessions.length}</p>
            </div>
            <Activity size={32} className="text-byuRoyal" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Messages</p>
              <p className="text-3xl font-bold text-byuNavy mt-1">
                {activeSessions.reduce((sum, s) => sum + parseInt(s.message_count || 0), 0)}
              </p>
            </div>
            <MessageSquare size={32} className="text-byuRoyal" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Users</p>
              <p className="text-3xl font-bold text-byuNavy mt-1">
                {new Set(activeSessions.map(s => s.user_id)).size}
              </p>
            </div>
            <Users size={32} className="text-byuRoyal" />
          </div>
        </div>
      </div>

      {/* Sessions Table */}
      {loading && <div className="text-center py-8 text-gray-600">Loading active sessions...</div>}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      )}

      {!loading && !error && activeSessions.length === 0 && (
        <div className="bg-white p-8 rounded-lg shadow text-center text-gray-600">
          No active sessions at the moment
        </div>
      )}

      {!loading && !error && activeSessions.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-byuNavy text-white">
              <tr>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">Session ID</th>
                <th className="px-4 py-3 text-left">Started</th>
                <th className="px-4 py-3 text-left">Duration</th>
                <th className="px-4 py-3 text-left">Messages</th>
                <th className="px-4 py-3 text-left">Last Activity</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeSessions.map((session, idx) => {
                const isRecentlyActive = session.last_activity &&
                  (Date.now() - new Date(session.last_activity)) < 30000; // 30s

                return (
                  <tr
                    key={session.session_id}
                    className={`hover:bg-gray-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isRecentlyActive && (
                          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" title="Active now"></span>
                        )}
                        {session.username || 'Anonymous'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm text-gray-600">
                        {session.session_id.substring(0, 8)}...
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {new Date(session.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {formatDuration(session.duration_seconds)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-sm">
                        {session.message_count || 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {getTimeSince(session.last_activity)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => onViewSession(session.session_id, false)}
                          className="px-3 py-1 bg-byuRoyal text-white rounded hover:bg-byuNavy transition text-sm"
                        >
                          Monitor
                        </button>
                        <button
                          onClick={() => handleEndSession(session.session_id, session.username)}
                          className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition text-sm"
                          title="Remotely end this session"
                        >
                          End Session
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
