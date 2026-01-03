import { useState, useEffect, useRef } from "react";
import { X } from "react-feather";
import ConversationBubble from "./ConversationBubble";
import { useSocket } from '../hooks/useSocket';

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

  const { socket } = useSocket();
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);

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
        setMessages(prev => [...prev, ...data.messages]);

        // Smart scroll: only if user is at bottom
        if (isAtBottom) {
          setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }, 100);
        }
      }
    };

    const handleSessionStatus = (data) => {
      if (data.status === 'ended') {
        setSession(prev => ({ ...prev, status: 'ended' }));
      }
    };

    socket.on('messages:new', handleNewMessages);
    socket.on('session:status', handleSessionStatus);

    return () => {
      socket.emit('session:leave', { sessionId });
      socket.off('messages:new', handleNewMessages);
      socket.off('session:status', handleSessionStatus);
    };
  }, [socket, sessionId, isAtBottom]);

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
      alert(`Export failed: ${err.message}`);
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
      alert('Please enter a message');
      return;
    }

    if (!socket) {
      alert('Not connected to server. Please refresh the page.');
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

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-4xl h-5/6 rounded-lg shadow-xl flex flex-col">
        <header className="bg-byuNavy text-white p-4 flex justify-between items-start rounded-t-lg">
          <div className="flex-1">
            <h2 className="text-xl font-bold">
              {session?.session_name || 'Session Details'}
            </h2>
            <p className="text-xs text-gray-300 mt-1 font-mono">{sessionId}</p>
            {isEditMode && (
              <div className="mt-2 bg-yellow-500 text-yellow-900 px-3 py-1 rounded text-sm inline-block font-semibold">
                Edit Mode: You can edit or delete messages
              </div>
            )}
            {session && (
              <div className="text-sm text-byuLightBlue mt-2 space-y-1">
                <div>User: <span className="font-semibold">{session.username || 'Anonymous'}</span></div>
                <div>Status: <span className={`font-semibold ${session.status === 'ended' ? 'text-gray-300' : 'text-green-300'}`}>{session.status}</span></div>
                <div>Started: {formatDate(session.created_at)}</div>
                {session.ended_at && (
                  <div>Ended: {formatDate(session.ended_at)}</div>
                )}
                <div>{messages.length} messages</div>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white hover:bg-opacity-20 rounded transition"
          >
            <X size={24} />
          </button>
        </header>

        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4">
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

          {!loading && !error && messages.length > 0 && (
            <div className="space-y-2">
              {messages.map((msg) => (
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
            <div className="p-4 bg-yellow-50 border-b border-yellow-200">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-yellow-900">Send message to participant:</span>
                <select
                  value={messageType}
                  onChange={(e) => setMessageType(e.target.value)}
                  className="px-2 py-1 border border-yellow-400 rounded text-sm bg-white"
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
                  className="flex-1 px-3 py-2 border border-yellow-400 rounded focus:outline-none focus:ring-2 focus:ring-yellow-500"
                  disabled={sendingMessage}
                />
                <button
                  onClick={handleSendAdminMessage}
                  disabled={sendingMessage || !adminMessage.trim()}
                  className="bg-yellow-500 text-yellow-900 px-4 py-2 rounded hover:bg-yellow-600 transition disabled:opacity-50 disabled:cursor-not-allowed font-semibold"
                >
                  {sendingMessage ? 'Sending...' : 'Send'}
                </button>
              </div>
              <p className="text-xs text-yellow-700 mt-1">
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
              className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy transition"
            >
              Export JSON
            </button>
            <button
              onClick={() => handleExport('csv')}
              className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy transition"
            >
              Export CSV
            </button>
            <button
              onClick={onClose}
              className="bg-gray-200 text-gray-800 px-4 py-2 rounded hover:bg-gray-300 transition ml-auto"
            >
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
