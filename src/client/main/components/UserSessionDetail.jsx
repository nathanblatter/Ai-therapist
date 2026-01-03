import { useState, useEffect } from "react";
import { X } from "react-feather";

export default function UserSessionDetail({ sessionId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSession = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/sessions/${sessionId}`);
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

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
            {session && (
              <div className="text-sm text-byuLightBlue mt-2 space-y-1">
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

        <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
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
            <div className="space-y-3">
              {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex w-full ${msg.role === 'user' ? 'justify-end' : msg.role === 'assistant' ? 'justify-start' : 'justify-center'}`}
                >
                  <div className={`max-w-xl px-4 py-3 rounded-2xl ${
                    msg.role === 'user'
                      ? 'bg-byuRoyal text-white rounded-br-none'
                      : msg.role === 'assistant'
                      ? 'bg-byuLightBlue text-black rounded-bl-none'
                      : 'bg-gray-200 text-gray-700 rounded-none'
                  }`}>
                    <div className="text-xs opacity-70 mb-1">
                      {msg.role.toUpperCase()} | {formatTime(msg.created_at)}
                    </div>
                    <div className="whitespace-pre-line">{msg.content || '(No message content)'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="border-t p-4 flex gap-2 bg-white rounded-b-lg">
          <button
            onClick={onClose}
            className="bg-byuRoyal text-white px-4 py-2 rounded hover:bg-byuNavy transition ml-auto"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
