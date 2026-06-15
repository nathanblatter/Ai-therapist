import { useState, useEffect, useRef } from "react";
import { X, AlertTriangle } from "react-feather";
import ConversationBubble from "./ConversationBubble";
import { useSocket } from '../hooks/useSocket';
import { toast } from "../../shared/components/Toast";

export default function SessionDetail({ sessionId, onClose, isEditMode = false }) {
  const [messages, setMessages] = useState([]);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editedContent, setEditedContent] = useState('');
  const [userRole, setUserRole] = useState(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [adminMessage, setAdminMessage] = useState('');
  const [messageType, setMessageType] = useState('visible'); // 'visible' or 'invisible'
  const [sendingMessage, setSendingMessage] = useState(false);
  const [sidebandConnected, setSidebandConnected] = useState(false);
  const [showInstructionsModal, setShowInstructionsModal] = useState(false);
  const [newInstructions, setNewInstructions] = useState('');
  const [updatingInstructions, setUpdatingInstructions] = useState(false);
  const [filterToolCalls, setFilterToolCalls] = useState(false);
  const [showFlagModal, setShowFlagModal] = useState(false);
  const [flagSeverity, setFlagSeverity] = useState('medium');
  const [flagNotes, setFlagNotes] = useState('');
  const [flagging, setFlagging] = useState(false);

  const { socket } = useSocket();
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const instructionsTextareaRef = useRef(null);
  const severitySelectRef = useRef(null);

  useEffect(() => {
    const fetchSession = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/admin/api/sessions/${sessionId}`);
        if (!response.ok) throw new Error('Failed to fetch session details');

        const data = await response.json();
        setMessages(data.messages);
        setSession(data.session);

        // Initialize sideband connection status from session data
        if (data.session?.sideband_connected) {
          setSidebandConnected(true);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
  }, [sessionId]);

  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const response = await fetch('/api/auth/status');
        if (response.ok) {
          const data = await response.json();
          setUserRole(data.role);
        }
      } catch (err) {
        console.error('Failed to fetch user role:', err);
      }
    };

    fetchUserRole();
  }, []);

  // Track scroll position for smart scroll
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollHeight - scrollTop - clientHeight < 50;
      setIsAtBottom(atBottom);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Socket.io real-time updates
  useEffect(() => {
    if (!socket || !sessionId) return;

    // Join session room
    socket.emit('session:join', { sessionId });
    console.log(`Joined session room: ${sessionId}`);

    const handleNewMessages = (data) => {
      if (data.sessionId === sessionId) {
        console.log(`Received ${data.messages.length} new messages`);

        // Process messages with role-based content selection
        const processedMessages = data.messages.map(msg => ({
          ...msg,
          message: userRole === 'therapist' ? msg.content : msg.content_redacted
        }));

        setMessages(prev => [...prev, ...processedMessages]);

        // Smart scroll: only if user is at bottom
        if (isAtBottom) {
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }, 100);
        }
      }
    };

    const handleMessageRedacted = (data) => {
      // Update message with redacted content when redaction completes
      setMessages(prev => prev.map(msg =>
        msg.message_id === data.messageId
          ? { ...msg, message: data.content_redacted }
          : msg
      ));
      console.log(`Message ${data.messageId} redaction completed`);
    };

    const handleSessionStatus = (data) => {
      if (data.status === 'ended') {
        setSession(prev => ({ ...prev, status: 'ended' }));
      }
    };

    const handleSidebandConnected = (data) => {
      if (data.sessionId === sessionId) {
        console.log('Sideband connected:', data);
        setSidebandConnected(true);
        setSession(prev => ({ ...prev, sideband_connected: true }));
      }
    };

    const handleSidebandDisconnected = (data) => {
      if (data.sessionId === sessionId) {
        console.log('Sideband disconnected:', data);
        setSidebandConnected(false);
        setSession(prev => ({ ...prev, sideband_connected: false }));
      }
    };

    const handleSidebandError = (data) => {
      if (data.sessionId === sessionId) {
        console.error('Sideband error:', data.error);
      }
    };

    const handleInstructionsUpdated = (data) => {
      if (data.sessionId === sessionId) {
        console.log('Instructions updated by:', data.updatedBy);
        toast.info(`Instructions updated by ${data.updatedBy}`);
      }
    };

    socket.on('messages:new', handleNewMessages);
    socket.on('message:redacted', handleMessageRedacted);
    socket.on('session:status', handleSessionStatus);
    socket.on('sideband:connected', handleSidebandConnected);
    socket.on('sideband:disconnected', handleSidebandDisconnected);
    socket.on('sideband:error', handleSidebandError);
    socket.on('session:instructions-updated', handleInstructionsUpdated);

    return () => {
      socket.emit('session:leave', { sessionId });
      socket.off('messages:new', handleNewMessages);
      socket.off('message:redacted', handleMessageRedacted);
      socket.off('session:status', handleSessionStatus);
      socket.off('sideband:connected', handleSidebandConnected);
      socket.off('sideband:disconnected', handleSidebandDisconnected);
      socket.off('sideband:error', handleSidebandError);
      socket.off('session:instructions-updated', handleInstructionsUpdated);
    };
  }, [socket, sessionId, isAtBottom, userRole]);

  // Handle Escape key and auto-focus for Update Instructions modal
  useEffect(() => {
    if (!showInstructionsModal) return;

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        setShowInstructionsModal(false);
        setNewInstructions('');
      }
    };

    // Auto-focus textarea
    if (instructionsTextareaRef.current) {
      instructionsTextareaRef.current.focus();
    }

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showInstructionsModal]);

  // Handle Escape key and auto-focus for Flag Crisis modal
  useEffect(() => {
    if (!showFlagModal) return;

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        setShowFlagModal(false);
        setFlagNotes('');
        setFlagSeverity('medium');
      }
    };

    // Auto-focus severity select
    if (severitySelectRef.current) {
      severitySelectRef.current.focus();
    }

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showFlagModal]);

  const handleExport = async (format) => {
    try {
      const response = await fetch(`/admin/api/export?format=${format}&sessionId=${sessionId}`);
      if (!response.ok) throw new Error('Failed to export session');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}-export.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    }
  };

  const handleEditMessage = (messageId, currentContent) => {
    setEditingMessageId(messageId);
    setEditedContent(currentContent);
  };

  const handleSaveMessage = async (messageId) => {
    if (!editedContent.trim()) {
      setError('Message content cannot be empty');
      return;
    }

    try {
      const response = await fetch(`/admin/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editedContent })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update message');
      }

      const { message: updatedMessage } = await response.json();

      // Update local state - server returns message in same format as initial fetch
      setMessages(messages.map(msg =>
        msg.message_id === messageId
          ? { ...msg, message: updatedMessage.message, extras: updatedMessage.extras }
          : msg
      ));

      setEditingMessageId(null);
      setEditedContent('');
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteMessage = async (messageId) => {
    if (!window.confirm('Are you sure you want to delete this message?')) {
      return;
    }

    try {
      const response = await fetch(`/admin/api/messages/${messageId}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete message');
      }

      // Remove from local state
      setMessages(messages.filter(msg => msg.message_id !== messageId));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditedContent('');
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const handleSendAdminMessage = () => {
    if (!adminMessage.trim()) {
      toast.error('Please enter a message');
      return;
    }

    if (!socket) {
      toast.error('Not connected to server. Please refresh the page.');
      return;
    }

    setSendingMessage(true);

    // Send message via Socket.io
    socket.emit('admin:sendMessage', {
      sessionId,
      message: adminMessage.trim(),
      messageType
    });

    // Add to local messages for immediate feedback (only for visible messages)
    if (messageType === 'visible') {
      const newMessage = {
        message_id: `temp-${Date.now()}`,
        session_id: sessionId,
        role: 'system',
        message_type: `admin_${messageType}`,
        message: `[Message from you]: ${adminMessage.trim()}`,
        created_at: new Date().toISOString(),
        extras: { admin_sent: true }
      };
      setMessages(prev => [...prev, newMessage]);
    }

    // Clear input and reset state
    setAdminMessage('');
    setSendingMessage(false);

    // Show confirmation
    const typeText = messageType === 'visible' ? 'Message sent to user' : 'Invisible prompt sent to AI';
    console.log(`${typeText}: ${adminMessage.trim()}`);
  };

  const handleUpdateInstructions = async () => {
    if (!newInstructions.trim()) {
      toast.error('Please enter instructions');
      return;
    }

    setUpdatingInstructions(true);

    try {
      const response = await fetch(`/admin/api/sessions/${sessionId}/update-instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ instructions: newInstructions })
      });

      if (response.ok) {
        toast.success('Instructions updated successfully!');
        setShowInstructionsModal(false);
        setNewInstructions('');
      } else {
        const errorData = await response.json();
        toast.error(`Failed to update instructions: ${errorData.error}`);
      }
    } catch (error) {
      console.error('Error updating instructions:', error);
      toast.error('Error updating instructions');
    } finally {
      setUpdatingInstructions(false);
    }
  };

  const handleFlagCrisis = async () => {
    if (!flagSeverity) {
      toast.error('Please select a severity level');
      return;
    }

    setFlagging(true);

    try {
      const response = await fetch(`/admin/api/sessions/${sessionId}/crisis/flag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          severity: flagSeverity,
          notes: flagNotes
        })
      });

      if (response.ok) {
        const data = await response.json();
        // Update local session state
        setSession(prev => ({
          ...prev,
          crisis_flagged: true,
          crisis_severity: data.severity,
          crisis_risk_score: data.riskScore,
          crisis_flagged_at: data.flaggedAt,
          crisis_flagged_by: data.flaggedBy
        }));
        setShowFlagModal(false);
        setFlagNotes('');
        toast.success(`Session flagged as ${flagSeverity} risk`);
      } else {
        const errorData = await response.json();
        toast.error(`Failed to flag session: ${errorData.error}`);
      }
    } catch (error) {
      console.error('Error flagging crisis:', error);
      toast.error('Error flagging session');
    } finally {
      setFlagging(false);
    }
  };

  const handleUnflagCrisis = async () => {
    const confirmMessage = 'Are you sure you want to remove the crisis flag from this session?';

    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      const response = await fetch(`/admin/api/sessions/${sessionId}/crisis/flag`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ notes: 'Manually unflagged via admin panel' })
      });

      if (response.ok) {
        // Update local session state
        setSession(prev => ({
          ...prev,
          crisis_flagged: false,
          crisis_severity: null,
          crisis_risk_score: null,
          crisis_flagged_at: null,
          crisis_flagged_by: null
        }));
        toast.success('Crisis flag removed');
      } else {
        const errorData = await response.json();
        toast.error(`Failed to unflag session: ${errorData.error}`);
      }
    } catch (error) {
      console.error('Error unflagging crisis:', error);
      toast.error('Error unflagging session');
    }
  };

  const getCrisisBadgeClasses = (severity) => {
    const badges = {
      high: 'bg-red-600 text-white animate-pulse',
      medium: 'bg-yellow-500 text-yellow-900',
      low: 'bg-orange-400 text-orange-900'
    };
    return badges[severity] || 'bg-gray-400 text-gray-900';
  };

  // Filter messages for display
  const displayMessages = filterToolCalls
    ? messages.filter(msg => msg.message_type === 'tool_call' || msg.message_type === 'tool_response')
    : messages;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-detail-title"
    >
      <div className="bg-white w-full max-w-4xl h-5/6 rounded-lg shadow-xl flex flex-col">
        <header className="bg-byuNavy text-white p-4 flex justify-between items-start rounded-t-lg">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h2 id="session-detail-title" className="text-xl font-bold">
                {session?.session_name || 'Session Details'}
              </h2>
              {session?.crisis_flagged && (
                <span className={`px-3 py-1 rounded text-sm font-semibold uppercase flex items-center gap-1 ${getCrisisBadgeClasses(session.crisis_severity)}`}>
                  <AlertTriangle size={16} />
                  {session.crisis_severity} RISK
                </span>
              )}
            </div>
            <p className="text-xs text-gray-300 mt-1 font-mono">{sessionId}</p>
            {session?.crisis_flagged && (
              <div className="mt-2 text-xs bg-red-900 bg-opacity-30 px-3 py-2 rounded">
                <div><strong>Risk Score:</strong> {session.crisis_risk_score}/100</div>
                <div><strong>Flagged by:</strong> {session.crisis_flagged_by}</div>
                <div><strong>Flagged at:</strong> {new Date(session.crisis_flagged_at).toLocaleString()}</div>
              </div>
            )}
            {isEditMode && (
              <div className="mt-2 bg-yellow-500 text-yellow-900 px-3 py-1 rounded text-sm inline-block font-semibold">
                Edit Mode: You can edit or delete messages
              </div>
            )}
            {session && (
              <div className="text-sm text-byuLightBlue mt-2 space-y-1">
                <div>User: <span className="font-semibold">{session.username || 'Anonymous'}</span></div>
                <div className="flex items-center gap-2">
                  <span>Status: <span className={`font-semibold ${session.status === 'ended' ? 'text-gray-300' : 'text-green-300'}`}>{session.status}</span></span>
                  {session.status === 'active' && (session.sideband_connected || sidebandConnected) && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-500 text-white">
                      🔗 Sideband Active
                    </span>
                  )}
                  {session.status === 'active' && session.openai_call_id && !(session.sideband_connected || sidebandConnected) && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-500 text-yellow-900">
                      ⚠️ Sideband Disconnected
                    </span>
                  )}
                </div>
                <div>Started: {formatDate(session.created_at)}</div>
                {session.ended_at && (
                  <div>Ended: {formatDate(session.ended_at)}</div>
                )}
                <div>{messages.length} messages</div>
                {filterToolCalls && (
                  <div className="text-yellow-300">Showing tool calls only ({displayMessages.length} messages)</div>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {session?.status === 'active' && (session.sideband_connected || sidebandConnected) && (
                <button
                  onClick={() => setShowInstructionsModal(true)}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm font-medium transition min-h-[44px]"
                  aria-label="Update AI instructions for this session"
                >
                  Update Instructions
                </button>
              )}
              {session?.crisis_flagged ? (
                <button
                  onClick={handleUnflagCrisis}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-medium transition min-h-[44px]"
                  aria-label="Remove crisis flag from this session"
                >
                  Unflag Crisis
                </button>
              ) : (
                <button
                  onClick={() => setShowFlagModal(true)}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm font-medium transition flex items-center gap-1 min-h-[44px]"
                  aria-label="Flag this session as crisis"
                >
                  <AlertTriangle size={16} aria-hidden="true" />
                  Flag Crisis
                </button>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white hover:bg-opacity-20 rounded transition min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close session details"
          >
            <X size={24} />
          </button>
        </header>

        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4">
          {/* Filter Toggle */}
          {!loading && messages.length > 0 && (
            <div className="mb-4 flex gap-2" role="group" aria-label="Message filter">
              <button
                onClick={() => setFilterToolCalls(false)}
                aria-pressed={!filterToolCalls}
                aria-label="Show all messages"
                className={`px-3 py-1 rounded text-sm font-medium transition min-h-[44px] ${!filterToolCalls ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
              >
                All Messages
              </button>
              <button
                onClick={() => setFilterToolCalls(true)}
                aria-pressed={filterToolCalls}
                aria-label="Show tool calls only"
                className={`px-3 py-1 rounded text-sm font-medium transition min-h-[44px] ${filterToolCalls ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
              >
                Tool Calls Only
              </button>
            </div>
          )}

          {loading && (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading conversation...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error}
            </div>
          )}

          {!loading && !error && messages.length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500">No messages found</p>
            </div>
          )}

          {!loading && !error && displayMessages.length === 0 && filterToolCalls && (
            <div className="text-center py-8">
              <p className="text-gray-500">No tool calls in this session</p>
            </div>
          )}

          {!loading && !error && displayMessages.length > 0 && (
            <div className="space-y-2">
              {displayMessages.map((msg) => (
                <ConversationBubble
                  key={msg.message_id}
                  message={msg}
                  isEditMode={isEditMode}
                  isEditing={editingMessageId === msg.message_id}
                  editedContent={editedContent}
                  onEdit={() => handleEditMessage(msg.message_id, msg.message)}
                  onSave={() => handleSaveMessage(msg.message_id)}
                  onDelete={() => handleDeleteMessage(msg.message_id)}
                  onCancel={handleCancelEdit}
                  onContentChange={setEditedContent}
                  userRole={userRole}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <footer className="border-t">
          {/* Admin Message Input - Only show for active sessions */}
          {session?.status === 'active' && (
            <div className="p-4 bg-yellow-50 border-b border-yellow-200" role="form" aria-label="Send message to participant">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-yellow-900">Send message to participant:</span>
                <select
                  value={messageType}
                  onChange={(e) => setMessageType(e.target.value)}
                  aria-label="Select message visibility type"
                  className="px-2 py-1 border border-yellow-400 rounded text-sm bg-white min-h-[44px]"
                >
                  <option value="visible">Visible (user sees it)</option>
                  <option value="invisible">Invisible (guides AI only)</option>
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={adminMessage}
                  onChange={(e) => setAdminMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendAdminMessage()}
                  placeholder={messageType === 'visible' ? 'Type a message to show the user...' : 'Type an instruction for the AI...'}
                  aria-label={messageType === 'visible' ? 'Message to send to user' : 'Invisible instruction for AI'}
                  className="flex-1 px-3 py-2 border border-yellow-400 rounded focus:outline-none focus:ring-2 focus:ring-yellow-500 min-h-[44px]"
                  disabled={sendingMessage}
                />
                <button
                  onClick={handleSendAdminMessage}
                  disabled={sendingMessage || !adminMessage.trim()}
                  aria-label={sendingMessage ? 'Sending message' : 'Send message'}
                  className="bg-yellow-500 text-yellow-900 px-4 py-2 rounded hover:bg-yellow-600 transition disabled:opacity-50 disabled:cursor-not-allowed font-semibold min-h-[44px]"
                >
                  {sendingMessage ? 'Sending...' : 'Send'}
                </button>
              </div>
              <p className="text-xs text-yellow-700 mt-1" aria-live="polite">
                {messageType === 'visible'
                  ? 'The user will see this message in their chat interface.'
                  : 'This will be sent to the AI as context, invisible to the user.'}
              </p>
            </div>
          )}

          {/* Export and Close buttons */}
          <div className="p-4 flex gap-2">
            <button
              onClick={() => handleExport('json')}
              aria-label="Export session as JSON file"
              className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy transition min-h-[44px]"
            >
              Export JSON
            </button>
            <button
              onClick={() => handleExport('csv')}
              aria-label="Export session as CSV file"
              className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy transition min-h-[44px]"
            >
              Export CSV
            </button>
            <button
              onClick={onClose}
              aria-label="Close session details"
              className="bg-gray-200 text-gray-800 px-4 py-2 rounded hover:bg-gray-300 transition ml-auto min-h-[44px]"
            >
              Close
            </button>
          </div>
        </footer>
      </div>

      {/* Update Instructions Modal */}
      {showInstructionsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="instructions-modal-title">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-2xl w-full mx-4">
            <h3 id="instructions-modal-title" className="text-lg font-semibold mb-4">Update Session Instructions</h3>
            <p className="text-sm text-gray-600 mb-4">
              Update the AI's behavior and instructions for this session. Changes take effect immediately.
            </p>
            <textarea
              ref={instructionsTextareaRef}
              className="w-full h-48 p-3 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={newInstructions}
              onChange={(e) => setNewInstructions(e.target.value)}
              placeholder="Enter new instructions for the AI assistant..."
              aria-label="New instructions for AI assistant"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowInstructionsModal(false);
                  setNewInstructions('');
                }}
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 transition min-h-[44px]"
                disabled={updatingInstructions}
                aria-label="Cancel instruction update"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateInstructions}
                disabled={updatingInstructions || !newInstructions.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition min-h-[44px]"
                aria-label={updatingInstructions ? 'Updating instructions' : 'Submit new instructions'}
              >
                {updatingInstructions ? 'Updating...' : 'Update Instructions'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Flag Crisis Modal */}
      {showFlagModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-labelledby="flag-crisis-modal-title">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle size={24} className="text-red-600" aria-hidden="true" />
              <h3 id="flag-crisis-modal-title" className="text-lg font-semibold">Flag Session as Crisis</h3>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Mark this session for crisis intervention. Select the severity level and add any relevant notes.
            </p>

            <div className="mb-4">
              <label htmlFor="crisis-severity" className="block text-sm font-medium text-gray-700 mb-2">
                Severity Level <span className="text-red-500" aria-label="required">*</span>
              </label>
              <select
                ref={severitySelectRef}
                id="crisis-severity"
                value={flagSeverity}
                onChange={(e) => setFlagSeverity(e.target.value)}
                aria-label="Select crisis severity level"
                className="w-full p-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-red-500 min-h-[44px]"
              >
                <option value="low">Low - General concern</option>
                <option value="medium">Medium - Moderate risk (recommended)</option>
                <option value="high">High - Immediate attention required</option>
              </select>
            </div>

            <div className="mb-4">
              <label htmlFor="crisis-notes" className="block text-sm font-medium text-gray-700 mb-2">
                Notes (Optional)
              </label>
              <textarea
                id="crisis-notes"
                value={flagNotes}
                onChange={(e) => setFlagNotes(e.target.value)}
                aria-label="Additional notes about crisis (optional)"
                className="w-full h-24 p-3 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Add any relevant notes about why this session is being flagged..."
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowFlagModal(false);
                  setFlagNotes('');
                  setFlagSeverity('medium');
                }}
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300 transition min-h-[44px]"
                disabled={flagging}
                aria-label="Cancel crisis flagging"
              >
                Cancel
              </button>
              <button
                onClick={handleFlagCrisis}
                disabled={flagging}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1 min-h-[44px]"
                aria-label={flagging ? 'Flagging session as crisis' : 'Submit crisis flag'}
              >
                {flagging ? (
                  'Flagging...'
                ) : (
                  <>
                    <AlertTriangle size={16} aria-hidden="true" />
                    Flag Crisis
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
