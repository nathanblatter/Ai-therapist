import { useState, useEffect } from "react";
import { X } from "react-feather";
import ConversationBubble from "./ConversationBubble";

export default function SessionDetail({ sessionId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSession = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/admin/api/sessions/${sessionId}`);
        if (!response.ok) throw new Error('Failed to fetch session details');

        const data = await response.json();
        setMessages(data.messages);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
  }, [sessionId]);

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

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-4xl h-5/6 rounded-lg shadow-xl flex flex-col">
        <header className="bg-byuNavy text-white p-4 flex justify-between items-start rounded-t-lg">
          <div>
            <h2 className="text-xl font-bold">Session: {sessionId}</h2>
            {messages.length > 0 && (
              <p className="text-sm text-byuLightBlue mt-1">
                {messages.length} messages | Started: {formatDate(messages[0]?.created_at)}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white hover:bg-opacity-20 rounded transition"
          >
            <X size={24} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
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
                <ConversationBubble key={msg.id} message={msg} />
              ))}
            </div>
          )}
        </div>

        <footer className="border-t p-4 flex gap-2">
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
        </footer>
      </div>
    </div>
  );
}
