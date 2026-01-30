import { useState, useEffect } from 'react';
import { Activity, Users, MessageSquare, AlertTriangle, X, Radio } from 'react-feather';
import { useSocket } from '../hooks/useSocket';
import { toast } from '../../shared/components/Toast';
import RoomAssignment from './RoomAssignment';

export default function LiveMonitoring({ onViewSession }) {
  const [activeSessions, setActiveSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCrisisOnly, setShowCrisisOnly] = useState(false);
  const [crisisAlert, setCrisisAlert] = useState(null);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(false);
  const { socket, connected } = useSocket();

  // Sideband monitoring state
  const [sidebandConnections, setSidebandConnections] = useState([]);
  const [selectedSidebandSession, setSelectedSidebandSession] = useState(null);
  const [sidebandEvents, setSidebandEvents] = useState({});
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateInstructions, setUpdateInstructions] = useState('');

  // Initial fetch
  useEffect(() => {
    fetchActiveSessions();
  }, []);

  // Request browser notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        setBrowserNotificationsEnabled(permission === 'granted');
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      setBrowserNotificationsEnabled(true);
    }
  }, []);

  // Socket.io real-time listeners
  useEffect(() => {
    if (!socket) return;

    // Request initial sideband connections
    socket.emit('admin:get-sideband-connections');

    socket.on('session:created', handleSessionCreated);
    socket.on('session:ended', handleSessionEnded);
    socket.on('session:activity', handleSessionActivity);
    socket.on('session:crisis-detected', handleCrisisDetected);
    socket.on('session:crisis-flagged', handleCrisisFlagged);
    socket.on('session:crisis-unflagged', handleCrisisUnflagged);

    // Sideband event listeners
    socket.on('sideband:connected', handleSidebandConnected);
    socket.on('sideband:disconnected', handleSidebandDisconnected);
    socket.on('sideband:status-update', handleSidebandStatusUpdate);
    socket.on('sideband:error', handleSidebandError);
    socket.on('session:openai-update', handleOpenAIUpdate);
    socket.on('admin:sideband-connections', handleSidebandConnectionsList);

    return () => {
      socket.off('session:created', handleSessionCreated);
      socket.off('session:ended', handleSessionEnded);
      socket.off('session:activity', handleSessionActivity);
      socket.off('session:crisis-detected', handleCrisisDetected);
      socket.off('session:crisis-flagged', handleCrisisFlagged);
      socket.off('session:crisis-unflagged', handleCrisisUnflagged);
      socket.off('sideband:connected', handleSidebandConnected);
      socket.off('sideband:disconnected', handleSidebandDisconnected);
      socket.off('sideband:status-update', handleSidebandStatusUpdate);
      socket.off('sideband:error', handleSidebandError);
      socket.off('session:openai-update', handleOpenAIUpdate);
      socket.off('admin:sideband-connections', handleSidebandConnectionsList);
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

  const handleCrisisDetected = (data) => {
    // Update session in state
    setActiveSessions(prev =>
      prev.map(session =>
        session.session_id === data.sessionId
          ? {
              ...session,
              crisis_flagged: true,
              crisis_severity: data.severity,
              crisis_risk_score: data.riskScore,
              crisis_flagged_at: data.detectedAt,
              crisis_flagged_by: 'system'
            }
          : session
      )
    );

    // Show alert banner (auto-dismiss after 30s)
    setCrisisAlert({
      sessionId: data.sessionId,
      severity: data.severity,
      riskScore: data.riskScore,
      message: data.message,
      type: 'auto'
    });
    setTimeout(() => setCrisisAlert(null), 30000);

    // Browser notification
    if (browserNotificationsEnabled) {
      new Notification(`${data.severity.toUpperCase()} Crisis Detected`, {
        body: `Session: ${data.sessionId.substring(0, 12)}...\nRisk Score: ${data.riskScore}`,
        icon: '/favicon.ico',
        requireInteraction: data.severity === 'high'
      });
    }
  };

  const handleCrisisFlagged = (data) => {
    // Update session in state
    setActiveSessions(prev =>
      prev.map(session =>
        session.session_id === data.sessionId
          ? {
              ...session,
              crisis_flagged: true,
              crisis_severity: data.severity,
              crisis_risk_score: data.riskScore,
              crisis_flagged_at: data.flaggedAt,
              crisis_flagged_by: data.flaggedBy
            }
          : session
      )
    );

    // Show alert banner (auto-dismiss after 15s for manual flags)
    setCrisisAlert({
      sessionId: data.sessionId,
      severity: data.severity,
      riskScore: data.riskScore,
      message: data.message,
      type: 'manual'
    });
    setTimeout(() => setCrisisAlert(null), 15000);
  };

  const handleCrisisUnflagged = (data) => {
    // Update session in state
    setActiveSessions(prev =>
      prev.map(session =>
        session.session_id === data.sessionId
          ? {
              ...session,
              crisis_flagged: false,
              crisis_severity: null,
              crisis_risk_score: null,
              crisis_flagged_at: null,
              crisis_flagged_by: null
            }
          : session
      )
    );
  };

  // Sideband event handlers
  const handleSidebandConnected = (data) => {
    console.log('[LiveMonitoring] Sideband connected:', data);
    setSidebandConnections(prev => {
      const exists = prev.find(c => c.sessionId === data.sessionId);
      if (exists) return prev;
      return [...prev, {
        sessionId: data.sessionId,
        callId: data.callId,
        connectedAt: data.connectedAt,
        status: 'connected'
      }];
    });
  };

  const handleSidebandDisconnected = (data) => {
    console.log('[LiveMonitoring] Sideband disconnected:', data);
    // Update status instead of removing (keep visible for debugging)
    setSidebandConnections(prev =>
      prev.map(c =>
        c.sessionId === data.sessionId
          ? { ...c, status: 'disconnected', disconnectedAt: data.disconnectedAt, closeCode: data.code, closeReason: data.reason }
          : c
      )
    );
  };

  const handleSidebandStatusUpdate = (data) => {
    console.log('[LiveMonitoring] Sideband status update:', data);
    setSidebandConnections(prev =>
      prev.map(c =>
        c.sessionId === data.sessionId
          ? { ...c, status: data.status, error: data.error, lastUpdate: data.timestamp }
          : c
      )
    );
  };

  const handleSidebandError = (data) => {
    console.error('[LiveMonitoring] Sideband error:', data);
    setSidebandEvents(prev => ({
      ...prev,
      [data.sessionId]: [
        ...(prev[data.sessionId] || []),
        {
          type: 'error',
          timestamp: new Date(),
          data: data.error
        }
      ].slice(-50)
    }));
  };

  const handleOpenAIUpdate = (data) => {
    console.log('[LiveMonitoring] OpenAI event:', data);
    setSidebandEvents(prev => ({
      ...prev,
      [data.sessionId]: [
        ...(prev[data.sessionId] || []),
        {
          type: data.eventType,
          timestamp: new Date(),
          data: data.data
        }
      ].slice(-50)
    }));
  };

  const handleSidebandConnectionsList = (connections) => {
    console.log('[LiveMonitoring] Sideband connections list:', connections);
    setSidebandConnections(connections);
  };

  const handleUpdateSession = async () => {
    if (!selectedSidebandSession || !updateInstructions.trim()) return;

    try {
      const response = await fetch('/admin/api/sideband/update-session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: selectedSidebandSession.sessionId,
          instructions: updateInstructions.trim()
        })
      });

      if (response.ok) {
        toast.success('Session instructions updated successfully');
        setShowUpdateModal(false);
        setUpdateInstructions('');
      } else {
        const error = await response.json();
        toast.error(`Failed to update: ${error.message}`);
      }
    } catch (error) {
      console.error('Error updating session:', error);
      toast.error('Failed to update session');
    }
  };

  const handleDisconnectSideband = async (sessionId) => {
    if (!confirm('Are you sure you want to disconnect this sideband connection?')) return;

    try {
      const response = await fetch('/admin/api/sideband/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });

      if (response.ok) {
        toast.success('Sideband connection disconnected');
        setSidebandConnections(prev => prev.filter(c => c.sessionId !== sessionId));
        if (selectedSidebandSession?.sessionId === sessionId) {
          setSelectedSidebandSession(null);
        }
      } else {
        const error = await response.json();
        toast.error(`Failed to disconnect: ${error.message}`);
      }
    } catch (error) {
      console.error('Error disconnecting:', error);
      toast.error('Failed to disconnect');
    }
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

  const getCrisisBadgeClasses = (severity) => {
    const badges = {
      high: 'bg-red-600 text-white animate-pulse',
      medium: 'bg-yellow-500 text-yellow-900',
      low: 'bg-orange-400 text-orange-900'
    };
    return badges[severity] || 'bg-gray-400 text-gray-900';
  };

  const getAlertBannerClasses = (severity) => {
    const classes = {
      high: 'bg-red-100 border-red-500 text-red-900',
      medium: 'bg-yellow-100 border-yellow-500 text-yellow-900',
      low: 'bg-orange-100 border-orange-500 text-orange-900'
    };
    return classes[severity] || 'bg-gray-100 border-gray-500 text-gray-900';
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
      toast.error(`Failed to end session: ${err.message}`);
    }
  };

  // Filter sessions
  const displayedSessions = showCrisisOnly
    ? activeSessions.filter(s => s.crisis_flagged)
    : activeSessions;

  const crisisCount = activeSessions.filter(s => s.crisis_flagged).length;

  // Get events for selected sideband session
  const selectedSidebandEvents = selectedSidebandSession
    ? (sidebandEvents[selectedSidebandSession.sessionId] || [])
    : [];

  return (
    <div className="p-6 space-y-6">
      {/* Crisis Alert Banner */}
      {crisisAlert && (
        <div
          className={`border-l-4 p-4 rounded ${getAlertBannerClasses(crisisAlert.severity)} flex items-center justify-between`}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle size={24} aria-hidden="true" />
            <div>
              <p className="font-bold">{crisisAlert.message}</p>
              <p className="text-sm">Session: {crisisAlert.sessionId.substring(0, 12)}... | Risk Score: {crisisAlert.riskScore}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onViewSession(crisisAlert.sessionId, false)}
              className="px-3 py-1 bg-white bg-opacity-50 rounded hover:bg-opacity-75 transition text-sm font-medium min-h-[44px]"
              aria-label={`View crisis session ${crisisAlert.sessionId.substring(0, 12)}`}
            >
              View Session
            </button>
            <button
              onClick={() => setCrisisAlert(null)}
              className="p-1 hover:bg-white hover:bg-opacity-25 rounded transition min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Dismiss crisis alert"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-byuNavy">Live Session Monitoring</h2>
          <p className="text-gray-600 mt-1">
            Real-time view of active therapy sessions
            {connected && <span className="ml-2 text-green-600" role="status" aria-live="polite">● Connected</span>}
            {!connected && <span className="ml-2 text-red-600" role="status" aria-live="assertive">● Disconnected</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCrisisOnly(!showCrisisOnly)}
            aria-pressed={showCrisisOnly}
            aria-label={showCrisisOnly ? 'Show all sessions' : 'Show crisis sessions only'}
            className={`px-4 py-2 rounded transition min-h-[44px] ${
              showCrisisOnly
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            {showCrisisOnly ? 'Show All' : 'Crisis Only'}
          </button>
          <button
            onClick={fetchActiveSessions}
            aria-label="Refresh active sessions list"
            className="px-4 py-2 bg-byuRoyal text-white rounded hover:bg-byuNavy transition min-h-[44px]"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-lg shadow" role="status" aria-live="polite">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Sessions</p>
              <p className="text-3xl font-bold text-byuNavy mt-1">{activeSessions.length}</p>
            </div>
            <Activity size={32} className="text-byuRoyal" aria-hidden="true" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg shadow" role="status" aria-live="polite">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Messages</p>
              <p className="text-3xl font-bold text-byuNavy mt-1">
                {activeSessions.reduce((sum, s) => sum + parseInt(s.message_count || 0), 0)}
              </p>
            </div>
            <MessageSquare size={32} className="text-byuRoyal" aria-hidden="true" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg shadow" role="status" aria-live="polite">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Users</p>
              <p className="text-3xl font-bold text-byuNavy mt-1">
                {new Set(activeSessions.map(s => s.user_id)).size}
              </p>
            </div>
            <Users size={32} className="text-byuRoyal" aria-hidden="true" />
          </div>
        </div>

        <div className={`p-4 rounded-lg shadow ${crisisCount > 0 ? 'bg-red-50' : 'bg-white'}`} role="status" aria-live="assertive">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Crisis Sessions</p>
              <p className={`text-3xl font-bold mt-1 ${crisisCount > 0 ? 'text-red-600' : 'text-byuNavy'}`}>
                {crisisCount}
              </p>
            </div>
            <AlertTriangle size={32} className={crisisCount > 0 ? 'text-red-600' : 'text-gray-400'} aria-hidden="true" />
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

      {!loading && !error && displayedSessions.length === 0 && (
        <div className="bg-white p-8 rounded-lg shadow text-center text-gray-600">
          {showCrisisOnly ? 'No crisis sessions at the moment' : 'No active sessions at the moment'}
        </div>
      )}

      {!loading && !error && displayedSessions.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden" role="region" aria-label="Active sessions table">
          <table className="w-full" role="table">
            <thead className="bg-byuNavy text-white">
              <tr>
                <th className="px-4 py-3 text-left" scope="col">Crisis</th>
                <th className="px-4 py-3 text-left" scope="col">User</th>
                <th className="px-4 py-3 text-left" scope="col">Session ID</th>
                <th className="px-4 py-3 text-left" scope="col">Started</th>
                <th className="px-4 py-3 text-left" scope="col">Duration</th>
                <th className="px-4 py-3 text-left" scope="col">Messages</th>
                <th className="px-4 py-3 text-left" scope="col">Last Activity</th>
                <th className="px-4 py-3 text-left" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedSessions.map((session, idx) => {
                const isRecentlyActive = session.last_activity &&
                  (Date.now() - new Date(session.last_activity)) < 30000; // 30s

                return (
                  <tr
                    key={session.session_id}
                    className={`hover:bg-gray-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} ${
                      session.crisis_flagged ? 'border-l-4 border-red-600' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      {session.crisis_flagged ? (
                        <div className="flex flex-col gap-1">
                          <span className={`px-2 py-1 rounded text-xs font-semibold uppercase ${getCrisisBadgeClasses(session.crisis_severity)}`}>
                            {session.crisis_severity}
                          </span>
                          <span className="text-xs text-gray-600">
                            Score: {session.crisis_risk_score}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-400 text-sm">—</span>
                      )}
                    </td>
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
                      {new Date(session.created_at).toLocaleString('en-US', {
                        month: 'numeric',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                      })}
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
                          className="px-3 py-1 bg-byuRoyal text-white rounded hover:bg-byuNavy transition text-sm min-h-[44px]"
                          aria-label={`Monitor session for ${session.username || 'Anonymous'}`}
                        >
                          Monitor
                        </button>
                        <button
                          onClick={() => handleEndSession(session.session_id, session.username)}
                          className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition text-sm min-h-[44px]"
                          aria-label={`Remotely end session for ${session.username || 'Anonymous'}`}
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

      {/* Sideband Connection Monitor */}
      {sidebandConnections.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Radio size={24} className="text-byuRoyal" />
              <div>
                <h3 className="text-xl font-bold text-byuNavy">Sideband Connections</h3>
                <p className="text-sm text-gray-600">Server-side WebSocket connections to OpenAI Realtime API</p>
              </div>
            </div>
            <button
              onClick={() => socket?.emit('admin:get-sideband-connections')}
              className="px-4 py-2 bg-byuRoyal text-white rounded hover:bg-byuNavy transition text-sm min-h-[44px]"
            >
              Refresh Connections
            </button>
          </div>

          {/* Info banner for 404 errors */}
          {sidebandConnections.some(c => c.error?.includes('404')) && (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="text-yellow-600 flex-shrink-0" size={20} />
                <div>
                  <h5 className="font-semibold text-yellow-900 mb-1">OpenAI Sideband Feature Not Available</h5>
                  <p className="text-sm text-yellow-800">
                    OpenAI is returning 404 errors for sideband WebSocket connections. This feature may not be enabled for your API key yet.
                    Sideband connections allow server-side monitoring and control of Realtime API sessions.
                    The client-side WebRTC connection works normally - this only affects admin monitoring capabilities.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Connections List */}
            <div className="bg-white rounded-lg shadow p-4">
              <h4 className="font-semibold text-byuNavy mb-3">
                Connection Attempts ({sidebandConnections.length})
              </h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {sidebandConnections.map(conn => (
                  <button
                    key={conn.sessionId}
                    onClick={() => setSelectedSidebandSession(conn)}
                    className={`w-full text-left p-3 rounded-lg transition ${
                      selectedSidebandSession?.sessionId === conn.sessionId
                        ? 'bg-byuRoyal text-white'
                        : 'bg-gray-50 hover:bg-gray-100 text-gray-900'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full ${
                        conn.status === 'connected' ? 'bg-green-500 animate-pulse' :
                        conn.status === 'error' ? 'bg-red-500' :
                        conn.status === 'disconnected' ? 'bg-gray-400' :
                        'bg-yellow-500'
                      }`}></span>
                      <span className="font-mono text-sm font-medium">
                        {conn.sessionId.substring(0, 12)}...
                      </span>
                      <span className={`text-xs ml-auto ${
                        selectedSidebandSession?.sessionId === conn.sessionId
                          ? 'text-white opacity-75'
                          : 'text-gray-500'
                      }`}>
                        {conn.status || 'connected'}
                      </span>
                    </div>
                    <div className={`text-xs ${
                      selectedSidebandSession?.sessionId === conn.sessionId
                        ? 'text-white opacity-75'
                        : 'text-gray-600'
                    }`}>
                      Call ID: {conn.callId?.substring(0, 16)}...
                    </div>
                    <div className={`text-xs ${
                      selectedSidebandSession?.sessionId === conn.sessionId
                        ? 'text-white opacity-75'
                        : 'text-gray-500'
                    }`}>
                      {new Date(conn.connectedAt).toLocaleTimeString()}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Connection Details and Events */}
            <div className="lg:col-span-2 bg-white rounded-lg shadow p-4">
              {selectedSidebandSession ? (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold text-byuNavy">
                      Session: {selectedSidebandSession.sessionId.substring(0, 16)}...
                    </h4>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowUpdateModal(true)}
                        className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 transition text-sm min-h-[44px]"
                      >
                        Update Instructions
                      </button>
                      <button
                        onClick={() => handleDisconnectSideband(selectedSidebandSession.sessionId)}
                        className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 transition text-sm min-h-[44px]"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>

                  <div className="bg-gray-50 rounded p-3 mb-4 text-sm">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="font-medium text-gray-700">Call ID:</span>
                        <div className="font-mono text-xs text-gray-600 break-all">
                          {selectedSidebandSession.callId}
                        </div>
                      </div>
                      <div>
                        <span className="font-medium text-gray-700">Status:</span>
                        <div className={`font-semibold ${
                          selectedSidebandSession.status === 'connected' ? 'text-green-600' :
                          selectedSidebandSession.status === 'error' ? 'text-red-600' :
                          selectedSidebandSession.status === 'disconnected' ? 'text-gray-600' :
                          'text-yellow-600'
                        }`}>
                          {selectedSidebandSession.status || 'connected'}
                        </div>
                      </div>
                    </div>
                    {selectedSidebandSession.error && (
                      <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded">
                        <div className="font-medium text-red-700 text-xs mb-1">Error:</div>
                        <div className="text-xs text-red-600">{selectedSidebandSession.error}</div>
                      </div>
                    )}
                    {selectedSidebandSession.closeReason && (
                      <div className="mt-3 p-2 bg-gray-100 border border-gray-300 rounded">
                        <div className="font-medium text-gray-700 text-xs mb-1">
                          Close Reason (Code: {selectedSidebandSession.closeCode}):
                        </div>
                        <div className="text-xs text-gray-600">{selectedSidebandSession.closeReason || 'No reason provided'}</div>
                      </div>
                    )}
                  </div>

                  <div className="mb-2">
                    <h5 className="font-medium text-gray-700 text-sm mb-2">
                      OpenAI Events ({selectedSidebandEvents.length})
                    </h5>
                  </div>

                  <div className="bg-gray-50 rounded p-3 max-h-96 overflow-y-auto">
                    {selectedSidebandEvents.length === 0 ? (
                      <p className="text-gray-500 text-sm italic">No events yet</p>
                    ) : (
                      <div className="space-y-2">
                        {selectedSidebandEvents.map((event, idx) => (
                          <div
                            key={idx}
                            className={`p-2 rounded text-xs ${
                              event.type === 'error'
                                ? 'bg-yellow-50 border-l-2 border-yellow-500'
                                : 'bg-white border-l-2 border-blue-500'
                            }`}
                          >
                            <div className="flex justify-between items-center mb-1">
                              <span className="font-semibold text-gray-900">{event.type}</span>
                              <span className="text-gray-500">
                                {new Date(event.timestamp).toLocaleTimeString()}
                              </span>
                            </div>
                            <pre className="text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-words">
                              {JSON.stringify(event.data, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500 italic">
                  Select a connection to view details
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Update Instructions Modal */}
      {showUpdateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <h3 className="text-xl font-bold text-byuNavy mb-4">Update Session Instructions</h3>
            <p className="text-gray-600 text-sm mb-4">
              Update the AI instructions for this session in real-time via the sideband connection.
              This will modify how the AI behaves without ending the session.
            </p>

            <textarea
              value={updateInstructions}
              onChange={(e) => setUpdateInstructions(e.target.value)}
              placeholder="Enter new instructions for the AI therapist..."
              className="w-full min-h-[200px] p-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-byuRoyal resize-vertical"
            />

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowUpdateModal(false);
                  setUpdateInstructions('');
                }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateSession}
                disabled={!updateInstructions.trim()}
                className={`px-4 py-2 rounded transition min-h-[44px] ${
                  updateInstructions.trim()
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
              >
                Update Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Room Assignment Diagram */}
      <RoomAssignment />
    </div>
  );
}
