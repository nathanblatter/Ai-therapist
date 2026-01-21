import React, { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';

export default function SidebandMonitor() {
  const socket = useSocket();
  const [activeConnections, setActiveConnections] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [events, setEvents] = useState({});
  const [instructions, setInstructions] = useState('');
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  useEffect(() => {
    if (!socket) return;

    // Request initial list of active connections
    socket.emit('admin:get-sideband-connections');

    // Listen for sideband connection events
    socket.on('sideband:connected', (data) => {
      console.log('[SidebandMonitor] Connection established:', data);
      setActiveConnections(prev => {
        const exists = prev.find(c => c.sessionId === data.sessionId);
        if (exists) return prev;
        return [...prev, {
          sessionId: data.sessionId,
          callId: data.callId,
          connectedAt: data.connectedAt,
          status: 'connected'
        }];
      });
    });

    socket.on('sideband:disconnected', (data) => {
      console.log('[SidebandMonitor] Connection closed:', data);
      setActiveConnections(prev =>
        prev.filter(c => c.sessionId !== data.sessionId)
      );
      if (selectedSession?.sessionId === data.sessionId) {
        setSelectedSession(null);
      }
    });

    socket.on('sideband:error', (data) => {
      console.error('[SidebandMonitor] Error:', data);
      setEvents(prev => ({
        ...prev,
        [data.sessionId]: [
          ...(prev[data.sessionId] || []),
          {
            type: 'error',
            timestamp: new Date(),
            data: data.error
          }
        ].slice(-50) // Keep last 50 events
      }));
    });

    socket.on('session:openai-update', (data) => {
      console.log('[SidebandMonitor] OpenAI event:', data);
      setEvents(prev => ({
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
    });

    socket.on('admin:sideband-connections', (connections) => {
      console.log('[SidebandMonitor] Active connections:', connections);
      setActiveConnections(connections);
    });

    return () => {
      socket.off('sideband:connected');
      socket.off('sideband:disconnected');
      socket.off('sideband:error');
      socket.off('session:openai-update');
      socket.off('admin:sideband-connections');
    };
  }, [socket, selectedSession]);

  const handleUpdateSession = async () => {
    if (!selectedSession || !instructions.trim()) return;

    try {
      const response = await fetch('/api/admin/sideband/update-session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: selectedSession.sessionId,
          instructions: instructions.trim()
        })
      });

      if (response.ok) {
        alert('Session instructions updated successfully');
        setShowUpdateModal(false);
        setInstructions('');
      } else {
        const error = await response.json();
        alert(`Failed to update: ${error.message}`);
      }
    } catch (error) {
      console.error('Error updating session:', error);
      alert('Failed to update session');
    }
  };

  const handleDisconnect = async (sessionId) => {
    if (!confirm('Are you sure you want to disconnect this sideband connection?')) return;

    try {
      const response = await fetch('/api/admin/sideband/disconnect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });

      if (response.ok) {
        setActiveConnections(prev => prev.filter(c => c.sessionId !== sessionId));
        if (selectedSession?.sessionId === sessionId) {
          setSelectedSession(null);
        }
      } else {
        const error = await response.json();
        alert(`Failed to disconnect: ${error.message}`);
      }
    } catch (error) {
      console.error('Error disconnecting:', error);
      alert('Failed to disconnect');
    }
  };

  const sessionEvents = selectedSession ? (events[selectedSession.sessionId] || []) : [];

  return (
    <div style={{
      padding: '20px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: '1400px',
      margin: '0 auto'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <h2 style={{ margin: 0 }}>Sideband Connection Monitor</h2>
        <button
          onClick={() => socket?.emit('admin:get-sideband-connections')}
          style={{
            padding: '8px 16px',
            backgroundColor: '#0066cc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Refresh
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 2fr',
        gap: '20px',
        marginBottom: '20px'
      }}>
        {/* Active Connections List */}
        <div style={{
          backgroundColor: '#f8f9fa',
          borderRadius: '8px',
          padding: '16px',
          border: '1px solid #dee2e6'
        }}>
          <h3 style={{ marginTop: 0 }}>
            Active Connections ({activeConnections.length})
          </h3>

          {activeConnections.length === 0 ? (
            <p style={{ color: '#6c757d', fontStyle: 'italic' }}>
              No active sideband connections
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activeConnections.map(conn => (
                <div
                  key={conn.sessionId}
                  onClick={() => setSelectedSession(conn)}
                  style={{
                    padding: '12px',
                    backgroundColor: selectedSession?.sessionId === conn.sessionId ? '#e7f3ff' : 'white',
                    border: selectedSession?.sessionId === conn.sessionId ? '2px solid #0066cc' : '1px solid #dee2e6',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '4px'
                  }}>
                    <div style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: '#28a745',
                      animation: 'pulse 2s infinite'
                    }} />
                    <strong style={{ fontSize: '14px' }}>
                      Session {conn.sessionId.substring(0, 8)}...
                    </strong>
                  </div>
                  <div style={{ fontSize: '12px', color: '#6c757d', marginLeft: '16px' }}>
                    Call ID: {conn.callId?.substring(0, 16)}...
                  </div>
                  <div style={{ fontSize: '11px', color: '#6c757d', marginLeft: '16px' }}>
                    Connected: {new Date(conn.connectedAt).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Connection Details */}
        <div style={{
          backgroundColor: '#f8f9fa',
          borderRadius: '8px',
          padding: '16px',
          border: '1px solid #dee2e6'
        }}>
          {selectedSession ? (
            <>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px'
              }}>
                <h3 style={{ margin: 0 }}>
                  Session: {selectedSession.sessionId.substring(0, 12)}...
                </h3>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => setShowUpdateModal(true)}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#28a745',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    Update Instructions
                  </button>
                  <button
                    onClick={() => handleDisconnect(selectedSession.sessionId)}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>

              <div style={{
                backgroundColor: 'white',
                borderRadius: '6px',
                padding: '12px',
                marginBottom: '12px',
                border: '1px solid #dee2e6'
              }}>
                <div style={{ fontSize: '13px', marginBottom: '6px' }}>
                  <strong>Call ID:</strong> {selectedSession.callId}
                </div>
                <div style={{ fontSize: '13px', marginBottom: '6px' }}>
                  <strong>Status:</strong>{' '}
                  <span style={{ color: '#28a745', fontWeight: 'bold' }}>
                    {selectedSession.status || 'connected'}
                  </span>
                </div>
                <div style={{ fontSize: '13px' }}>
                  <strong>Connected At:</strong>{' '}
                  {new Date(selectedSession.connectedAt).toLocaleString()}
                </div>
              </div>

              <h4 style={{ marginBottom: '8px' }}>
                Events ({sessionEvents.length})
              </h4>
              <div style={{
                backgroundColor: 'white',
                borderRadius: '6px',
                padding: '12px',
                maxHeight: '400px',
                overflowY: 'auto',
                border: '1px solid #dee2e6'
              }}>
                {sessionEvents.length === 0 ? (
                  <p style={{ color: '#6c757d', fontStyle: 'italic', margin: 0 }}>
                    No events yet
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {sessionEvents.map((event, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '8px',
                          backgroundColor: event.type === 'error' ? '#fff3cd' : '#f8f9fa',
                          borderRadius: '4px',
                          borderLeft: `3px solid ${event.type === 'error' ? '#ffc107' : '#0066cc'}`,
                          fontSize: '12px'
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: '4px'
                        }}>
                          <strong>{event.type}</strong>
                          <span style={{ color: '#6c757d' }}>
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <pre style={{
                          margin: 0,
                          fontSize: '11px',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: '150px',
                          overflowY: 'auto'
                        }}>
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#6c757d',
              fontStyle: 'italic'
            }}>
              Select a connection to view details
            </div>
          )}
        </div>
      </div>

      {/* Update Instructions Modal */}
      {showUpdateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '600px',
            width: '90%',
            maxHeight: '80vh',
            overflowY: 'auto'
          }}>
            <h3 style={{ marginTop: 0 }}>Update Session Instructions</h3>
            <p style={{ color: '#6c757d', fontSize: '14px' }}>
              Update the AI instructions for this session. This will modify how the AI behaves
              in real-time without ending the session.
            </p>

            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Enter new instructions for the AI therapist..."
              style={{
                width: '100%',
                minHeight: '150px',
                padding: '12px',
                border: '1px solid #dee2e6',
                borderRadius: '4px',
                fontSize: '14px',
                fontFamily: 'inherit',
                resize: 'vertical',
                marginBottom: '16px'
              }}
            />

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px'
            }}>
              <button
                onClick={() => {
                  setShowUpdateModal(false);
                  setInstructions('');
                }}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateSession}
                disabled={!instructions.trim()}
                style={{
                  padding: '8px 16px',
                  backgroundColor: instructions.trim() ? '#28a745' : '#dee2e6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: instructions.trim() ? 'pointer' : 'not-allowed'
                }}
              >
                Update Session
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
