import { useState, useEffect } from 'react';
import { RefreshCw, Save, Check, AlertCircle, User, MessageSquare } from 'react-feather';
import { formatDateTime } from '../../shared/format';
import { getJson, postJson } from '../../shared/http';
import { leftoverCapitalisedWords } from '../../../shared/leftoverNames';

interface RedactionCheck {
  /** Absent on rows written before ai-therapist-288. */
  status?: 'checked' | 'errored';
  p_leak: number;
  /** null when the check errored (unknown, not clean). */
  flagged: boolean | null;
  /** Did the model's answer alone reach the threshold? Absent on rows checked
   *  before ai-therapist-409, where the model was the only reason to flag. */
  model_flagged?: boolean;
  /** Kinds of identifier the model thinks remain, e.g. ["organization"]. */
  kinds?: string[];
  backend: string;
  model: string;
  checked_at: string;
  reviewed?: boolean;
  error?: string;
}

interface RedactMessage {
  message_id: string;
  role: string;
  message_type: string;
  created_at: string;
  content_redacted: string | null;
  /** Decision-model leak-check verdict (ai-therapist-262); null when never checked. */
  redaction_check?: RedactionCheck | null;
  /** Stored as written: the redaction model refused it and the identifier
   *  check found nothing to redact (ai-therapist-409). */
  redaction_passthrough?: boolean;
}

/** Reviewer wording for the leak check's kinds (identifierCheck.ts). */
const KIND_LABELS: Record<string, string> = {
  person_name: 'a name',
  organization: 'an organisation',
  place: 'a place',
  date: 'a date',
  contact_or_number: 'a contact detail or number',
};

/** At most six words, then a count of the rest. */
function summariseWords(words: string[]): string {
  const shown = words.slice(0, 6).join(', ');
  return words.length > 6 ? `${shown} and ${words.length - 6} more` : shown;
}

/** The leak check did not produce an answer (ai-therapist-288). Older rows carry only `error`. */
function leakCheckErrored(check: RedactionCheck | null | undefined): boolean {
  return !!check && (check.status === 'errored' || typeof check.error === 'string');
}

// Researcher-only redaction-verification view: review and correct the
// auto-redacted message content served by /redact/api (redaction.routes.ts).
// Formerly the standalone /redact SSR app; merged into admin.
export default function RedactionReview() {
  const [messages, setMessages] = useState<RedactMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [flaggedUnreviewed, setFlaggedUnreviewed] = useState<number>(0);
  const [erroredUnreviewed, setErroredUnreviewed] = useState<number>(0);

  const fetchMessages = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getJson<{
        messages: RedactMessage[];
        flagged_unreviewed?: number;
        errored_unreviewed?: number;
      }>('/redact/api/messages', {
        fallback: 'Failed to fetch messages',
      });
      setMessages(data.messages);
      setFlaggedUnreviewed(Number(data.flagged_unreviewed ?? 0));
      setErroredUnreviewed(Number(data.errored_unreviewed ?? 0));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMessages();
  }, []);

  const handleEdit = (message: RedactMessage) => {
    setEditingId(message.message_id);
    setEditValue(message.content_redacted || '');
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditValue('');
  };

  const handleSave = async (messageId: string) => {
    setSaving(messageId);
    setSaveSuccess(null);
    try {
      await postJson(
        `/redact/api/messages/${messageId}`,
        { content_redacted: editValue },
        { method: 'PUT', fallback: 'Failed to save' },
      );

      // Update local state
      setMessages((prev) => prev.map((m) => (m.message_id === messageId ? { ...m, content_redacted: editValue } : m)));
      setEditingId(null);
      setEditValue('');
      setSaveSuccess(messageId);
      setTimeout(() => setSaveSuccess(null), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(null);
    }
  };

  const formatDate = formatDateTime;

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <header className="bg-white border-b shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Redaction Verification</h1>
            <p className="text-sm text-gray-600 mt-1">Review and edit redacted message content</p>
            {flaggedUnreviewed > 0 && (
              <p className="text-sm text-amber-700 mt-1 flex items-center gap-1.5">
                <AlertCircle size={14} />
                {flaggedUnreviewed} message{flaggedUnreviewed === 1 ? '' : 's'} flagged by the leak-check await review;
                they are listed first.
              </p>
            )}
            {erroredUnreviewed > 0 && (
              <p className="text-sm text-red-700 mt-1 flex items-center gap-1.5">
                <AlertCircle size={14} />
                {erroredUnreviewed} message{erroredUnreviewed === 1 ? '' : 's'} could not be leak-checked (the check
                errored) and {erroredUnreviewed === 1 ? 'has' : 'have'} not been verified; listed after the flagged
                ones.
              </p>
            )}
          </div>
          <button
            onClick={fetchMessages}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            Load More
          </button>
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
            <RefreshCw size={32} className="animate-spin mx-auto text-gray-400" />
            <p className="mt-4 text-gray-600">Loading messages...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-lg border">
            <p className="text-gray-600">No redacted messages found.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div key={message.message_id} className="bg-white rounded-lg border shadow-sm overflow-hidden">
                {/* Message Header */}
                <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-sm font-medium ${
                        message.role === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}
                    >
                      {message.role === 'user' ? <User size={14} /> : <MessageSquare size={14} />}
                      {message.role}
                    </span>
                    <span className="text-sm text-gray-500">{message.message_type}</span>
                    <span className="text-sm text-gray-400">{formatDate(message.created_at)}</span>
                    {message.redaction_check?.flagged &&
                      !message.redaction_check.reviewed &&
                      (message.redaction_check.model_flagged ?? true) && (
                        <span
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-amber-100 text-amber-800"
                          title={`Leak-check (${message.redaction_check.backend}, ${message.redaction_check.model}) says an identifier may remain`}
                        >
                          <AlertCircle size={12} />
                          Possible leak
                          {message.redaction_check.kinds?.length
                            ? ` (${message.redaction_check.kinds.map((k) => KIND_LABELS[k] ?? k).join(', ')})`
                            : ''}
                          , p={message.redaction_check.p_leak.toFixed(2)}
                        </span>
                      )}
                    {message.redaction_check?.flagged &&
                      !message.redaction_check.reviewed &&
                      leftoverCapitalisedWords(message.content_redacted ?? '').length > 0 && (
                        <span
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-amber-100 text-amber-800"
                          title="These words are still capitalised like a name. Redaction leaves in the names of schools, employers, clinics and congregations, so check each one."
                        >
                          <AlertCircle size={12} />
                          Possible name left in:{' '}
                          {summariseWords(leftoverCapitalisedWords(message.content_redacted ?? ''))}
                        </span>
                      )}
                    {message.redaction_passthrough && (
                      <span
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-gray-200 text-gray-700"
                        title="The redaction model refused this message. A separate check found no identifier in it, so it was stored exactly as written."
                      >
                        Stored as written
                      </span>
                    )}
                    {leakCheckErrored(message.redaction_check) && !message.redaction_check?.reviewed && (
                      <span
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-100 text-red-800"
                        title={`Leak-check errored (${message.redaction_check?.error ?? 'no detail'}); this message has not been verified`}
                      >
                        <AlertCircle size={12} />
                        Leak-check did not run
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 font-mono">ID: {message.message_id}</span>
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
                          <span className="text-gray-400 italic">(empty - click to edit)</span>
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
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              Load New Batch (Random Order)
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
