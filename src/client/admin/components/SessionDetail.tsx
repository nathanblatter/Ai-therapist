import { useState, useEffect, useRef } from "react";
import { X, AlertTriangle, Eye, FileText, Link2, Check, Clock } from "react-feather";
import ConversationBubble from "./ConversationBubble";
import SessionInsightsPanel from "./SessionInsightsPanel";
import SessionEvalPanel from "./SessionEvalPanel";
import RiskTimeline from "./RiskTimeline";
import { useSocket } from '../hooks/useSocket';
import useAuth from '../hooks/useAuth';
import { toast } from "../../shared/components/Toast";
import { formatDateTime } from "../../shared/format";
import { severityBadgeClass } from "../../shared/severity";

interface Message {
  message_id: string;
  session_id: string;
  role: string;
  message_type: string;
  message: string;
  created_at: string;
  extras?: Record<string, unknown>;
  content?: string;
  content_redacted?: string;
}

interface Session {
  session_id?: string;
  session_name?: string;
  user_id?: number | null;
  username?: string;
  status?: string;
  created_at?: string;
  ended_at?: string;
  sideband_connected?: boolean;
  openai_call_id?: string;
  crisis_flagged?: boolean;
  crisis_severity?: string;
  crisis_risk_score?: number | null;
  crisis_flagged_at?: string | null;
  crisis_flagged_by?: string | null;
  checkin?: { mood?: number; topic?: string; goal?: string } | null;
  is_demo?: boolean;
}

// One card, two uses (caseworker portal, spec section 4): the caseworker
// "summary view" notice (session detail is transcript-tier, so caseworkers
// see profile-side summaries instead) and the sandbox empty-transcript state
// (only showcase sessions are seeded with transcripts).
function TranscriptNoticeCard({ variant }: { variant: 'caseworker-summary' | 'sandbox-empty' }) {
  const isCaseworker = variant === 'caseworker-summary';
  const Icon = isCaseworker ? Eye : FileText;
  return (
    <div className="my-6 mx-auto max-w-lg rounded-lg border border-blue-200 bg-blue-50 p-5 text-center">
      <Icon size={22} className="mx-auto mb-2 text-blue-500" aria-hidden="true" />
      <h3 className="text-sm font-semibold text-blue-900">
        {isCaseworker ? 'Summary view' : 'No transcript for this session'}
      </h3>
      <p className="mt-1 text-sm text-blue-800">
        {isCaseworker
          ? 'Your role sees AI summaries and safety signals for this client. The full transcript is available to the treating therapist.'
          : 'This synthetic sandbox session was seeded without a transcript. Open one of the client’s showcase sessions to see a full conversation; summaries and signals above are populated for every session.'}
      </p>
    </div>
  );
}

// Post-session feedback (ai-therapist-25b) shown in Session Detail.
interface SessionFeedback {
  helpfulness_rating: number | null;
  ease_rating: number | null;
  would_return_rating: number | null;
  comments: string | null;
  created_at: string;
}

// Per-session cost/token summary (ai-therapist-25c) shown in Session Detail.
interface SessionCost {
  realtime_minutes: number | null;
  calls_by_purpose: { insights: number; redaction: number; crisis: number };
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
}

interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
  isEditMode?: boolean;
}

interface NewMessagesData {
  sessionId: string;
  messages: Message[];
}

interface SessionStatusData {
  status: string;
}

interface SidebandData {
  sessionId: string;
  error?: string;
}

interface InstructionsUpdatedData {
  sessionId: string;
  updatedBy: string;
}

interface FlagCrisisResponse {
  severity: string;
  riskScore: number;
  flaggedAt: string;
  flaggedBy: string;
}

export default function SessionDetail({ sessionId, onClose, isEditMode = false }: SessionDetailProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const { role: userRole, isSandbox: viewerIsSandbox } = useAuth();
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
  const [recording, setRecording] = useState<{ url: string; durationMs: number | null } | null>(null);
  const [redactionStatus, setRedactionStatus] = useState<{
    status: 'complete' | 'partial' | 'pending' | 'no_content';
    total: number;
    redacted: number;
    pending: number;
  } | null>(null);
  const [feedback, setFeedback] = useState<SessionFeedback | null>(null);
  const [cost, setCost] = useState<SessionCost | null>(null);

  const { socket } = useSocket();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const instructionsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const severitySelectRef = useRef<HTMLSelectElement>(null);

  const fetchRedactionStatus = async () => {
    try {
      const res = await fetch(`/admin/api/sessions/${sessionId}/redaction-status`);
      if (!res.ok) return;
      const data = await res.json();
      setRedactionStatus({ status: data.status, total: data.total, redacted: data.redacted, pending: data.pending });
    } catch (err) {
      console.error('Failed to fetch redaction status:', err);
    }
  };

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
        setFeedback(data.feedback ?? null);
        setCost(data.cost ?? null);

        // Initialize sideband connection status from session data
        if (data.session?.sideband_connected) {
          setSidebandConnected(true);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
    fetchRedactionStatus();
  }, [sessionId]);

  // Load the session recording once it's available (ready only after the
  // session ends and the audio is uploaded to object storage).
  useEffect(() => {
    let cancelled = false;
    const fetchRecording = async () => {
      try {
        const res = await fetch(`/admin/api/sessions/${sessionId}/recording-info`);
        if (!res.ok) return;
        const info = await res.json();
        if (!cancelled) {
          setRecording(info.available ? { url: info.url, durationMs: info.durationMs } : null);
        }
      } catch {
        /* no recording yet */
      }
    };
    fetchRecording();
    return () => { cancelled = true; };
  }, [sessionId, session?.status]);

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

    const handleNewMessages = (data: NewMessagesData) => {
      if (data.sessionId === sessionId) {
        console.log(`Received ${data.messages.length} new messages`);

        // Therapists always see raw content; researchers see raw content while
        // the session is active (live monitoring is exempt from redaction) and
        // the redacted column only once it has ended.
        const showUnredacted = userRole === 'therapist' || session?.status === 'active';
        const processedMessages: Message[] = data.messages.map((msg: Message) => ({
          ...msg,
          message: (showUnredacted ? msg.content : msg.content_redacted) ?? msg.message
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

    // Redaction now runs once per session at session end. When it completes,
    // refetch so researchers' redacted view picks up the populated content.
    const handleSessionRedactionComplete = (data: { sessionId: string; count: number }) => {
      if (data.sessionId !== sessionId) return;
      console.log(`Session redaction completed (${data.count} messages); refreshing`);
      fetch(`/admin/api/sessions/${sessionId}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.messages) setMessages(d.messages); })
        .catch(err => console.error('Failed to refresh after redaction:', err));
      fetchRedactionStatus();
    };

    const handleSessionStatus = (data: SessionStatusData) => {
      if (data.status === 'ended') {
        setSession(prev => prev ? { ...prev, status: 'ended' } : prev);
      }
    };

    const handleSidebandConnected = (data: SidebandData) => {
      if (data.sessionId === sessionId) {
        console.log('Sideband connected:', data);
        setSidebandConnected(true);
        setSession(prev => prev ? { ...prev, sideband_connected: true } : prev);
      }
    };

    const handleSidebandDisconnected = (data: SidebandData) => {
      if (data.sessionId === sessionId) {
        console.log('Sideband disconnected:', data);
        setSidebandConnected(false);
        setSession(prev => prev ? { ...prev, sideband_connected: false } : prev);
      }
    };

    const handleSidebandError = (data: SidebandData) => {
      if (data.sessionId === sessionId) {
        console.error('Sideband error:', data.error);
      }
    };

    const handleInstructionsUpdated = (data: InstructionsUpdatedData) => {
      if (data.sessionId === sessionId) {
        console.log('Instructions updated by:', data.updatedBy);
        toast.info(`Instructions updated by ${data.updatedBy}`);
      }
    };

    socket.on('messages:new', handleNewMessages);
    socket.on('session:redaction-complete', handleSessionRedactionComplete);
    socket.on('session:status', handleSessionStatus);
    socket.on('sideband:connected', handleSidebandConnected);
    socket.on('sideband:disconnected', handleSidebandDisconnected);
    socket.on('sideband:error', handleSidebandError);
    socket.on('session:instructions-updated', handleInstructionsUpdated);

    return () => {
      socket.emit('session:leave', { sessionId });
      socket.off('messages:new', handleNewMessages);
      socket.off('session:redaction-complete', handleSessionRedactionComplete);
      socket.off('session:status', handleSessionStatus);
      socket.off('sideband:connected', handleSidebandConnected);
      socket.off('sideband:disconnected', handleSidebandDisconnected);
      socket.off('sideband:error', handleSidebandError);
      socket.off('session:instructions-updated', handleInstructionsUpdated);
    };
  }, [socket, sessionId, isAtBottom, userRole, session?.status]);

  // Handle Escape key and auto-focus for Update Instructions modal
  useEffect(() => {
    if (!showInstructionsModal) return;

    const handleEscape = (e: KeyboardEvent) => {
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

    const handleEscape = (e: KeyboardEvent) => {
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

  const handleExport = async (format: string) => {
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
    } catch (err: unknown) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleEditMessage = (messageId: string, currentContent: string) => {
    setEditingMessageId(messageId);
    setEditedContent(currentContent);
  };

  const handleSaveMessage = async (messageId: string) => {
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditedContent('');
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
    } catch (error: unknown) {
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
        const data: FlagCrisisResponse = await response.json();
        // Update local session state
        setSession(prev => prev ? ({
          ...prev,
          crisis_flagged: true,
          crisis_severity: data.severity,
          crisis_risk_score: data.riskScore,
          crisis_flagged_at: data.flaggedAt,
          crisis_flagged_by: data.flaggedBy
        }) : prev);
        setShowFlagModal(false);
        setFlagNotes('');
        toast.success(`Session flagged as ${flagSeverity} risk`);
      } else {
        const errorData = await response.json();
        toast.error(`Failed to flag session: ${errorData.error}`);
      }
    } catch (error: unknown) {
      console.error('Error flagging crisis:', error);
      toast.error('Error flagging session');
    } finally {
      setFlagging(false);
    }
  };

  // Graceful crisis end (ai-therapist-112): the AI shares resources and closes
  // warmly over the sideband, with a server-side hard end as backstop —
  // contrast with the abrupt remote end.
  const handleCrisisWindDown = async () => {
    if (!window.confirm('Ask the AI to share crisis resources, close warmly, and end this session? It will be force-ended after 75 seconds if the wrap-up does not complete.')) {
      return;
    }
    try {
      const response = await fetch(`/admin/api/sessions/${sessionId}/crisis/wind-down`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await response.json();
      if (response.ok) {
        toast.success(data.message || 'Wind-down initiated');
      } else {
        toast.error(`Failed to start wind-down: ${data.error}`);
      }
    } catch (error: unknown) {
      console.error('Error initiating crisis wind-down:', error);
      toast.error('Error initiating crisis wind-down');
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
        setSession(prev => prev ? ({
          ...prev,
          crisis_flagged: false,
          crisis_severity: undefined,
          crisis_risk_score: null,
          crisis_flagged_at: null,
          crisis_flagged_by: null
        }) : prev);
        toast.success('Crisis flag removed');
      } else {
        const errorData = await response.json();
        toast.error(`Failed to unflag session: ${errorData.error}`);
      }
    } catch (error: unknown) {
      console.error('Error unflagging crisis:', error);
      toast.error('Error unflagging session');
    }
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
        <header className="bg-navy text-white p-4 flex justify-between items-start rounded-t-lg">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h2 id="session-detail-title" className="text-xl font-bold">
                {session?.session_name || 'Session Details'}
              </h2>
              {session?.crisis_flagged && (
                <span className={`px-3 py-1 rounded text-sm font-semibold uppercase flex items-center gap-1 ${severityBadgeClass(session.crisis_severity, { solid: true, pulseHigh: true })}`}>
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
                <div><strong>Flagged at:</strong> {session.crisis_flagged_at ? new Date(session.crisis_flagged_at).toLocaleString() : ''}</div>
              </div>
            )}
            {isEditMode && (
              <div className="mt-2 bg-yellow-500 text-yellow-900 px-3 py-1 rounded text-sm inline-block font-semibold">
                Edit Mode: You can edit or delete messages
              </div>
            )}
            {session && (
              <div className="text-sm text-lightBlue mt-2 space-y-1">
                <div>User: <span className="font-semibold">{session.username || 'Anonymous'}</span></div>
                <div className="flex items-center gap-2">
                  <span>Status: <span className={`font-semibold ${session.status === 'ended' ? 'text-gray-300' : 'text-green-300'}`}>{session.status}</span></span>
                  {session.status === 'active' && (session.sideband_connected || sidebandConnected) && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-500 text-white inline-flex items-center gap-1">
                      <Link2 size={12} aria-hidden="true" /> Sideband Active
                    </span>
                  )}
                  {session.status === 'active' && session.openai_call_id && !(session.sideband_connected || sidebandConnected) && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-500 text-yellow-900 inline-flex items-center gap-1">
                      <AlertTriangle size={12} aria-hidden="true" /> Sideband Disconnected
                    </span>
                  )}
                </div>
                <div>Started: {session.created_at ? formatDateTime(session.created_at) : ''}</div>
                {session.ended_at && (
                  <div>Ended: {formatDateTime(session.ended_at)}</div>
                )}
                {session.status === 'ended' && redactionStatus && redactionStatus.status !== 'no_content' && (
                  <div className="flex items-center gap-2">
                    <span>Redaction:</span>
                    <span
                      className={`px-2 py-0.5 text-xs font-medium rounded ${
                        redactionStatus.status === 'complete'
                          ? 'bg-green-600 text-white'
                          : redactionStatus.status === 'partial'
                          ? 'bg-yellow-500 text-yellow-900'
                          : 'bg-red-500 text-white'
                      }`}
                      title={`${redactionStatus.redacted}/${redactionStatus.total} messages redacted`}
                    >
                      {redactionStatus.status === 'complete' ? (
                        <span className="inline-flex items-center gap-1"><Check size={12} aria-hidden="true" /> Complete</span>
                      ) : redactionStatus.status === 'partial' ? (
                        <span className="inline-flex items-center gap-1"><AlertTriangle size={12} aria-hidden="true" /> Partial ({redactionStatus.redacted}/{redactionStatus.total})</span>
                      ) : (
                        <span className="inline-flex items-center gap-1"><Clock size={12} aria-hidden="true" /> Pending</span>
                      )}
                    </span>
                  </div>
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
                <>
                <button
                  onClick={handleUnflagCrisis}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-medium transition min-h-[44px]"
                  aria-label="Remove crisis flag from this session"
                >
                  Unflag Crisis
                </button>
                {session?.status === 'active' && (
                  <button
                    onClick={handleCrisisWindDown}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded text-sm font-medium transition min-h-[44px]"
                    aria-label="Have the AI share crisis resources, close warmly, and end the session"
                    title="The AI shares crisis resources and closes warmly; the session is force-ended if that doesn't finish within 75 seconds"
                  >
                    Wind Down & End
                  </button>
                )}
                </>
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
          {/* AI insights: check-in, memory summary, SOAP review (therapist only) */}
          {!loading && (
            <SessionInsightsPanel
              sessionId={sessionId}
              userRole={userRole}
              sessionStatus={session?.status}
              checkin={session?.checkin}
              participantUserId={session?.user_id}
            />
          )}

          {/* Per-message risk scores with the LLM's context judgment + reasoning */}
          {!loading && <RiskTimeline sessionId={sessionId} />}

          {/* LLM-judge quality scores (ended sessions only) */}
          {!loading && <SessionEvalPanel sessionId={sessionId} sessionStatus={session?.status} />}
          {/* Cost/token tracking (ai-therapist-25c) + participant feedback (ai-therapist-25b) */}
          {!loading && (cost || feedback) && (
            <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {cost && (
                <div className="bg-gray-50 border rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Session Cost & Usage</h3>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-gray-500">Realtime minutes</dt>
                    <dd>{cost.realtime_minutes ?? 'N/A'}</dd>
                    <dt className="text-gray-500">Insights calls</dt>
                    <dd>{cost.calls_by_purpose.insights}</dd>
                    <dt className="text-gray-500">Redaction calls</dt>
                    <dd>{cost.calls_by_purpose.redaction}</dd>
                    <dt className="text-gray-500">Crisis calls</dt>
                    <dd>{cost.calls_by_purpose.crisis}</dd>
                    <dt className="text-gray-500">Tokens (in / out)</dt>
                    <dd>{cost.tokens_in} / {cost.tokens_out}</dd>
                    <dt className="text-gray-500">Est. LLM cost</dt>
                    <dd>${cost.estimated_cost_usd.toFixed(4)}</dd>
                  </dl>
                </div>
              )}
              {feedback && (
                <div className="bg-gray-50 border rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Post-Session Feedback</h3>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-gray-500">Helpfulness</dt>
                    <dd>{feedback.helpfulness_rating ?? '—'} / 5</dd>
                    <dt className="text-gray-500">Ease of use</dt>
                    <dd>{feedback.ease_rating ?? '—'} / 5</dd>
                    <dt className="text-gray-500">Would return</dt>
                    <dd>{feedback.would_return_rating ?? '—'} / 5</dd>
                  </dl>
                  {feedback.comments && (
                    <p className="text-sm text-gray-700 mt-2 italic">&ldquo;{feedback.comments}&rdquo;</p>
                  )}
                </div>
              )}
            </div>
          )}

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

          {recording && (
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Session recording</span>
                {recording.durationMs != null && (
                  <span className="text-xs text-gray-500">
                    {Math.floor(recording.durationMs / 60000)}:
                    {String(Math.floor((recording.durationMs % 60000) / 1000)).padStart(2, '0')}
                  </span>
                )}
              </div>
              <audio controls preload="metadata" src={recording.url} className="w-full">
                Your browser does not support audio playback.
              </audio>
            </div>
          )}

          {loading && (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading conversation...</p>
            </div>
          )}

          {/* Caseworker tier: the session-detail transcript endpoint 404s for
              caseworkers by design — show the summary-view card, not an error. */}
          {!loading && userRole === 'caseworker' && (
            <TranscriptNoticeCard variant="caseworker-summary" />
          )}

          {error && userRole !== 'caseworker' && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error}
            </div>
          )}

          {!loading && !error && messages.length === 0 && userRole !== 'caseworker' && (
            session?.is_demo && viewerIsSandbox ? (
              <TranscriptNoticeCard variant="sandbox-empty" />
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-500">No messages found</p>
              </div>
            )
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
                  userRole={userRole ?? undefined}
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
              className="bg-royal text-white px-4 py-2 rounded hover:bg-navy transition min-h-[44px]"
            >
              Export JSON
            </button>
            <button
              onClick={() => handleExport('csv')}
              aria-label="Export session as CSV file"
              className="bg-royal text-white px-4 py-2 rounded hover:bg-navy transition min-h-[44px]"
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
