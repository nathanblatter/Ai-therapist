import { useState, useEffect } from "react";
import { RefreshCw, Save, Check, AlertCircle, User, MessageSquare, LogOut } from "react-feather";

export default function RedactApp() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(null);

  const handleLogout = async () => {
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      if (response.ok) {
        window.location.href = '/login';
      }
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  const fetchMessages = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/redact/api/messages", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch messages");
      }
      const data = await response.json();
      setMessages(data.messages);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMessages();
  }, []);

  const handleEdit = (message) => {
    setEditingId(message.message_id);
    setEditValue(message.content_redacted || "");
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditValue("");
  };

  const handleSave = async (messageId) => {
    setSaving(messageId);
    setSaveSuccess(null);
    try {
      const response = await fetch(`/redact/api/messages/${messageId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ content_redacted: editValue }),
      });

      if (!response.ok) {
        throw new Error("Failed to save");
      }

      // Update local state
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === messageId ? { ...m, content_redacted: editValue } : m
        )
      );
      setEditingId(null);
      setEditValue("");
      setSaveSuccess(messageId);
      setTimeout(() => setSaveSuccess(null), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  return (
    <div className="h-screen bg-gray-50 overflow-auto">
      {/* Header */}
      <header className="bg-white border-b shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Redaction Verification
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Review and edit redacted message content
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchMessages}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
              Load More
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition"
            >
              <LogOut size={18} />
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        )}

        {loading && messages.length === 0 ? (
          <div className="text-center py-12">
            <RefreshCw
              size={32}
              className="animate-spin mx-auto text-gray-400"
            />
            <p className="mt-4 text-gray-600">Loading messages...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border">
            <p className="text-gray-600">No redacted messages found.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.message_id}
                className="bg-white rounded-lg border shadow-sm overflow-hidden"
              >
                {/* Message Header */}
                <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-sm font-medium ${
                        message.role === "user"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {message.role === "user" ? (
                        <User size={14} />
                      ) : (
                        <MessageSquare size={14} />
                      )}
                      {message.role}
                    </span>
                    <span className="text-sm text-gray-500">
                      {message.message_type}
                    </span>
                    <span className="text-sm text-gray-400">
                      {formatDate(message.created_at)}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400 font-mono">
                    ID: {message.message_id}
                  </span>
                </div>

                {/* Message Content */}
                <div className="p-4">
                  {editingId === message.message_id ? (
                    <div className="space-y-3">
                      <textarea
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="w-full h-40 p-3 border rounded-lg font-mono text-sm resize-y focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Enter redacted content..."
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleSave(message.message_id)}
                          disabled={saving === message.message_id}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition"
                        >
                          {saving === message.message_id ? (
                            <RefreshCw size={16} className="animate-spin" />
                          ) : (
                            <Save size={16} />
                          )}
                          Save
                        </button>
                        <button
                          onClick={handleCancel}
                          className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() => handleEdit(message)}
                      className="cursor-pointer hover:bg-gray-50 p-3 -m-3 rounded-lg transition group"
                    >
                      <pre className="whitespace-pre-wrap font-mono text-sm text-gray-800">
                        {message.content_redacted || (
                          <span className="text-gray-400 italic">
                            (empty - click to edit)
                          </span>
                        )}
                      </pre>
                      <p className="text-xs text-gray-400 mt-2 opacity-0 group-hover:opacity-100 transition">
                        Click to edit
                      </p>
                    </div>
                  )}
                </div>

                {/* Success indicator */}
                {saveSuccess === message.message_id && (
                  <div className="px-4 py-2 bg-green-50 border-t border-green-100 flex items-center gap-2 text-green-700 text-sm">
                    <Check size={16} />
                    Saved successfully
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Load More Button at bottom */}
        {messages.length > 0 && (
          <div className="mt-8 text-center">
            <button
              onClick={fetchMessages}
              disabled={loading}
              className="inline-flex items-center gap-2 px-6 py-3 bg-white border rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
              Load New Batch (Random Order)
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
