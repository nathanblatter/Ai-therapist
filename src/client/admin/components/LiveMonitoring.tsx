import { useState, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { Activity, Users, MessageSquare, AlertTriangle, X, Radio } from 'react-feather';
import { useSocket } from '../hooks/useSocket';
import { toast } from '../../shared/components/Toast';
import { AudioStreamPlayer } from '../lib/audioStreamPlayer';

// ---- Local types ----

interface LiveSession {
  session_id: string;
  user_id: string;
  username: string | null;
  session_name: string | null;
  status: string;
  created_at: string;
  message_count: number;
  last_activity: string | null;
  duration_seconds: number;
  crisis_flagged?: boolean;
  crisis_severity?: string | null;
  crisis_risk_score?: number | null;
  crisis_flagged_at?: string | null;
  crisis_flagged_by?: string | null;
}

interface SidebandConnection {
  sessionId: string;
  callId: string;
  connectedAt: string;
  status: string;
  disconnectedAt?: string;
  closeCode?: number;
  closeReason?: string;
  error?: string;
  lastUpdate?: string;
}

interface SidebandEvent {
  type: string;
  timestamp: Date;
  data: unknown;
}

interface SidebandEventsMap {
  [sessionId: string]: SidebandEvent[];
}

// A single conversation turn in the live transcript, accumulated from sideband
// transcript deltas (keyed by the OpenAI item_id).
interface TranscriptTurn {
  itemId: string;
  role: 'assistant' | 'user';
  text: string;
  final: boolean;
  timestamp: string;
}

interface TranscriptMap {
  [sessionId: string]: TranscriptTurn[];
}

interface CrisisAlert {
  sessionId: string;
  severity: string;
  riskScore: number;
  message: string;
  type: 'auto' | 'manual';
}

interface LiveMonitoringProps {
  onViewSession: (sessionId: string, editMode: boolean) => void;
}

export default function LiveMonitoring({ onViewSession }: LiveMonitoringProps) {
  const [activeSessions, setActiveSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCrisisOnly, setShowCrisisOnly] = useState(false);
  const [crisisAlert, setCrisisAlert] = useState<CrisisAlert | null>(null);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(false);
  const { socket: rawSocket, connected } = useSocket();
  const socket = rawSocket as Socket | null;

  // Sideband monitoring state
  const [sidebandConnections, setSidebandConnections] = useState<SidebandConnection[]>([]);
  const [selectedSidebandSession, setSelectedSidebandSession] = useState<SidebandConnection | null>(null);
  const [sidebandEvents, setSidebandEvents] = useState<SidebandEventsMap>({});
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateInstructions, setUpdateInstructions] = useState('');
  // Advanced session.update: paste a raw JSON config (tools, tool_choice,
  // temperature, turn_detection, ...) instead of just instructions.
  const [advancedConfigMode, setAdvancedConfigMode] = useState(false);
  const [advancedConfigText, setAdvancedConfigText] = useState('');
  // Live two-sided transcript streamed from the sideband (no DB refresh).
  const [transcripts, setTranscripts] = useState<TranscriptMap>({});
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  // 1s tick so active-session durations and "time ago" advance smoothly.
  const [nowTick, setNowTick] = useState(Date.now());
  // Live assistant-audio listening (which session, and the player instance).
  const [listeningSessionId, setListeningSessionId] = useState<string | null>(null);
  const listeningSessionIdRef = useRef<string | null>(null);
  const audioPlayerRef = useRef<AudioStreamPlayer | null>(null);
  // Inject-message modal state.
  const [showInjectModal, setShowInjectModal] = useState(false);
  const [injectText, setInjectText] = useState('');
  const [injectRole, setInjectRole] = useState<'system' | 'user'>('system');
  const [injectRespond, setInjectRespond] = useState(false);

  // Initial fetch. After that the list is driven LIVE by socket/sideband
  // events (session:created / session:ended / session:activity); the endpoint
  // is only re-hit as a reconciliation seed after a socket reconnect.
  useEffect(() => {
    fetchActiveSessions();
  }, []);

  // Reconcile after every (re)connect: while the socket was down we missed
  // created/ended/activity events, so re-seed from the DB and re-request the
  // sideband connection list. (Runs on the initial connect too — the merge in
  // fetchActiveSessions makes that harmless.)
  useEffect(() => {
    if (!connected || !socket) return;
    fetchActiveSessions();
    socket.emit('admin:get-sideband-connections');
  }, [connected, socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drive live duration / "time ago" without waiting on socket events.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
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
    socket.on('session:eligibility-violation', handleEligibilityViolation);

    // Sideband event listeners
    socket.on('sideband:connected', handleSidebandConnected);
    socket.on('sideband:disconnected', handleSidebandDisconnected);
    socket.on('sideband:status-update', handleSidebandStatusUpdate);
    socket.on('sideband:error', handleSidebandError);
    socket.on('sideband:tool-call', handleSidebandToolCall);
    socket.on('sideband:transcript', handleSidebandTranscript);
    socket.on('audio:chunk', handleAudioChunk);
    socket.on('session:openai-update', handleOpenAIUpdate);
    socket.on('admin:sideband-connections', handleSidebandConnectionsList);

    return () => {
      socket.off('session:created', handleSessionCreated);
      socket.off('session:ended', handleSessionEnded);
      socket.off('session:activity', handleSessionActivity);
      socket.off('session:crisis-detected', handleCrisisDetected);
      socket.off('session:crisis-flagged', handleCrisisFlagged);
      socket.off('session:crisis-unflagged', handleCrisisUnflagged);
      socket.off('session:eligibility-violation', handleEligibilityViolation);
      socket.off('sideband:connected', handleSidebandConnected);
      socket.off('sideband:disconnected', handleSidebandDisconnected);
      socket.off('sideband:status-update', handleSidebandStatusUpdate);
      socket.off('sideband:error', handleSidebandError);
      socket.off('sideband:tool-call', handleSidebandToolCall);
      socket.off('sideband:transcript', handleSidebandTranscript);
      socket.off('audio:chunk', handleAudioChunk);
      socket.off('session:openai-update', handleOpenAIUpdate);
      socket.off('admin:sideband-connections', handleSidebandConnectionsList);
    };
  }, [socket]);

  // Feed incoming audio chunks to the player (ref guards against stale closure).
  const audioChunkCountRef = useRef(0);
  const handleAudioChunk = (data: { sessionId: string; pcm: string; sampleRate: number }) => {
    if (data.sessionId !== listeningSessionIdRef.current) return;
    if (audioChunkCountRef.current++ % 50 === 0) {
      console.log(`[Audio] received chunk #${audioChunkCountRef.current} (${data.pcm.length}b @ ${data.sampleRate}Hz)`);
    }
    audioPlayerRef.current?.push(data.pcm, data.sampleRate);
  };

  const startListening = (sessionId: string) => {
    if (!socket) {
      toast.error('No socket connection');
      return;
    }
    // Switch sources if already listening to a different session.
    if (listeningSessionIdRef.current && listeningSessionIdRef.current !== sessionId) {
      stopListening();
    }
    // Emit first so the request always reaches the server even if audio setup
    // throws; the participant won't tee until this arrives.
    console.log('[Audio] requesting listen for', sessionId);
    socket.emit('admin:audio-listen-start', { sessionId });
    listeningSessionIdRef.current = sessionId;
    setListeningSessionId(sessionId);
    try {
      const player = new AudioStreamPlayer();
      player.start(); // must run in the click handler (user gesture)
      audioPlayerRef.current = player;
      toast.info('Listening for assistant audio…');
    } catch (err) {
      console.error('[Audio] failed to start player:', err);
      toast.error('Audio playback unavailable in this browser');
    }
  };

  const stopListening = () => {
    const sessionId = listeningSessionIdRef.current;
    if (socket && sessionId) socket.emit('admin:audio-listen-stop', { sessionId });
    audioPlayerRef.current?.stop();
    audioPlayerRef.current = null;
    listeningSessionIdRef.current = null;
    setListeningSessionId(null);
  };

  // Tear down audio on unmount.
  useEffect(() => () => { stopListening(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the transcript pinned to the newest turn as it streams in.
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcripts, selectedSidebandSession]);

  // Late-join history (ai-therapist-16): live sideband deltas only cover
  // speech since THIS page loaded. When a session's transcript panel is first
  // opened, seed it once from the DB messages, then let live deltas continue
  // on top. DB turns older than the earliest live turn are prepended; anything
  // newer is already represented live (the DB flush lags ~15s), so it is
  // skipped to avoid duplicating turns.
  const seededTranscriptsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sid = selectedSidebandSession?.sessionId;
    if (!sid || seededTranscriptsRef.current.has(sid)) return;
    seededTranscriptsRef.current.add(sid);

    (async () => {
      try {
        const res = await fetch(`/admin/api/sessions/${sid}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const dbTurns: TranscriptTurn[] = (data.messages || [])
          .filter((m: { role: string; message: string | null }) =>
            (m.role === 'user' || m.role === 'assistant') && (m.message ?? '').trim())
          .map((m: { message_id: number; role: 'user' | 'assistant'; message: string; created_at: string }) => ({
            itemId: `db-${m.message_id}`,
            role: m.role,
            text: m.message.trim(),
            final: true,
            timestamp: m.created_at,
          }));
        if (dbTurns.length === 0) return;

        setTranscripts(prev => {
          const live = prev[sid] ?? [];
          const earliestLive = live.length > 0
            ? Math.min(...live.map(t => new Date(t.timestamp).getTime()))
            : Infinity;
          const history = dbTurns.filter(t => new Date(t.timestamp).getTime() < earliestLive);
          if (history.length === 0) return prev;
          return { ...prev, [sid]: [...history, ...live].slice(-200) };
        });
      } catch (err) {
        // Allow a retry next time the session is selected.
        seededTranscriptsRef.current.delete(sid);
        console.error(`[LiveMonitoring] Failed to seed transcript history for ${sid}:`, err);
      }
    })();
  }, [selectedSidebandSession]);

  // Accumulate live transcript deltas (keyed by item_id) into ordered turns.
  const handleSidebandTranscript = (data: {
    sessionId: string; role: 'assistant' | 'user'; itemId: string;
    delta?: string; text?: string; final: boolean; timestamp: string;
  }) => {
    setTranscripts(prev => {
      const turns = prev[data.sessionId] ? [...prev[data.sessionId]] : [];
      const idx = turns.findIndex(t => t.itemId === data.itemId);
      if (idx === -1) {
        turns.push({
          itemId: data.itemId,
          role: data.role,
          text: data.text ?? data.delta ?? '',
          final: data.final,
          timestamp: data.timestamp,
        });
      } else {
        const turn = turns[idx];
        // A final event carries the canonical full text; deltas append.
        if (data.final && data.text !== undefined) {
          turns[idx] = { ...turn, text: data.text, final: true };
        } else if (data.delta) {
          turns[idx] = { ...turn, text: turn.text + data.delta };
        }
      }
      return { ...prev, [data.sessionId]: turns.slice(-200) };
    });
  };

  const fetchActiveSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/api/sessions/active');
      if (!response.ok) throw new Error('Failed to fetch active sessions');
      const data = await response.json();
      // Parse numeric fields to ensure they're numbers, not strings
      const sessions: LiveSession[] = (data.sessions || []).map((session: LiveSession) => ({
        ...session,
        message_count: parseInt(String(session.message_count)) || 0,
        duration_seconds: parseFloat(String(session.duration_seconds)) || 0
      }));
      // MERGE with live state rather than replacing it: the DB lags the
      // sideband (messages flush every ~15s), so live counts/activity that are
      // AHEAD of the fetch win; sessions the fetch doesn't know about yet
      // (created while it was in flight) are kept.
      setActiveSessions(prev => {
        const bySessionId = new Map(prev.map(s => [s.session_id, s]));
        const merged = sessions.map(fetched => {
          const live = bySessionId.get(fetched.session_id);
          if (!live) return fetched;
          bySessionId.delete(fetched.session_id);
          return {
            ...fetched,
            message_count: Math.max(fetched.message_count, live.message_count || 0),
            last_activity:
              live.last_activity && (!fetched.last_activity ||
                new Date(live.last_activity) > new Date(fetched.last_activity))
                ? live.last_activity
                : fetched.last_activity,
          };
        });
        // Live-known sessions missing from the fetch, newest first (matches
        // handleSessionCreated's prepend behaviour).
        return [...Array.from(bySessionId.values()), ...merged];
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleSessionCreated = (data: { sessionId: string; userId: string; username: string; status: string; created_at: string }) => {
    setActiveSessions(prev => {
      if (prev.some(s => s.session_id === data.sessionId)) return prev;
      return [{
        session_id: data.sessionId,
        user_id: data.userId,
        username: data.username,
        session_name: null,
        status: data.status,
        created_at: data.created_at,
        message_count: 0,
        last_activity: data.created_at,
        duration_seconds: 0
      }, ...prev];
    });
  };

  const handleSessionEnded = (data: { sessionId: string }) => {
    setActiveSessions(prev =>
      prev.filter(s => s.session_id !== data.sessionId)
    );
  };

  // Activity arrives from two sources: the sideband (live, per-turn delta) and
  // the 15s DB flush (absolute total, for reconciliation). totalMessages sets the
  // count to truth; deltaMessages increments it live between flushes.
  const handleSessionActivity = (data: { sessionId: string; totalMessages?: number; deltaMessages?: number; messageCount?: number; lastActivity: string }) => {
    setActiveSessions(prev =>
      prev.map(session => {
        if (session.session_id !== data.sessionId) return session;
        const current = parseInt(String(session.message_count || 0));
        let nextCount = current;
        if (typeof data.totalMessages === 'number') {
          nextCount = data.totalMessages;
        } else if (typeof data.deltaMessages === 'number') {
          nextCount = current + data.deltaMessages;
        } else if (typeof data.messageCount === 'number') {
          nextCount = current + data.messageCount; // legacy delta shape
        }
        return { ...session, message_count: nextCount, last_activity: data.lastActivity };
      })
    );
  };

  // Age-eligibility violation (ai-therapist-106): a participant disclosed being
  // a minor and the session was auto-ended. Not a crisis flag — just a toast +
  // AE draft (surfaced in the Adverse Events tab).
  const handleEligibilityViolation = (data: { sessionId: string; statedAge: number | null; channel: string }) => {
    toast.warning(
      `Eligibility: session ${data.sessionId.substring(0, 12)}… disclosed being a minor` +
      `${data.statedAge != null ? ` (stated age ${data.statedAge})` : ''} and was ended. An adverse-event draft was created.`,
    );
  };

  const handleCrisisDetected = (data: { sessionId: string; severity: string; riskScore: number; detectedAt: string; message: string }) => {
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

  const handleCrisisFlagged = (data: { sessionId: string; severity: string; riskScore: number; flaggedAt: string; flaggedBy: string; message: string }) => {
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

  const handleCrisisUnflagged = (data: { sessionId: string }) => {
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
  const handleSidebandConnected = (data: { sessionId: string; callId: string; connectedAt: string }) => {
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

  const handleSidebandDisconnected = (data: { sessionId: string; disconnectedAt: string; code: number; reason: string }) => {
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

  const handleSidebandStatusUpdate = (data: { sessionId: string; status: string; error?: string; timestamp: string }) => {
    console.log('[LiveMonitoring] Sideband status update:', data);
    setSidebandConnections(prev =>
      prev.map(c =>
        c.sessionId === data.sessionId
          ? { ...c, status: data.status, error: data.error, lastUpdate: data.timestamp }
          : c
      )
    );
  };

  const handleSidebandError = (data: { sessionId: string; error: string }) => {
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

  const handleOpenAIUpdate = (data: { sessionId: string; eventType: string; data: unknown }) => {
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

  const handleSidebandToolCall = (data: { sessionId: string; toolName: string; status: string; args?: unknown; result?: unknown; error?: string; callId?: string }) => {
    console.log('[LiveMonitoring] Sideband tool call:', data);
    setSidebandEvents(prev => ({
      ...prev,
      [data.sessionId]: [
        ...(prev[data.sessionId] || []),
        { type: 'tool_call', timestamp: new Date(), data }
      ].slice(-50)
    }));
  };

  const handleSidebandConnectionsList = (connections: SidebandConnection[]) => {
    console.log('[LiveMonitoring] Sideband connections list:', connections);
    setSidebandConnections(connections);
  };

  const handleUpdateSession = async () => {
    if (!selectedSidebandSession) return;

    // Build payload: advanced mode sends a parsed JSON config; otherwise a
    // simple instructions string.
    let body: Record<string, unknown>;
    if (advancedConfigMode) {
      if (!advancedConfigText.trim()) return;
      let config: unknown;
      try {
        config = JSON.parse(advancedConfigText);
      } catch {
        toast.error('Config is not valid JSON');
        return;
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        toast.error('Config must be a JSON object');
        return;
      }
      body = { sessionId: selectedSidebandSession.sessionId, config };
    } else {
      if (!updateInstructions.trim()) return;
      body = { sessionId: selectedSidebandSession.sessionId, instructions: updateInstructions.trim() };
    }

    try {
      const response = await fetch('/admin/api/sideband/update-session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        toast.success('Session config updated successfully');
        setShowUpdateModal(false);
        setUpdateInstructions('');
        setAdvancedConfigText('');
        setAdvancedConfigMode(false);
      } else {
        const error = await response.json();
        toast.error(`Failed to update: ${error.details || error.error}`);
      }
    } catch (error: unknown) {
      console.error('Error updating session:', error);
      toast.error('Failed to update session');
    }
  };

  // Simple POST helper for the one-shot sideband controls.
  const postSideband = async (path: string, payload: Record<string, unknown>, successMsg: string) => {
    try {
      const response = await fetch(`/admin/api/sideband/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        toast.success(successMsg);
        return true;
      }
      const error = await response.json();
      toast.error(`Failed: ${error.details || error.error}`);
      return false;
    } catch (err: unknown) {
      console.error(`Error on ${path}:`, err);
      toast.error('Request failed');
      return false;
    }
  };

  const handleInterrupt = () => {
    if (!selectedSidebandSession) return;
    postSideband('interrupt', { sessionId: selectedSidebandSession.sessionId }, 'AI interrupted');
  };

  const handleForceResponse = () => {
    if (!selectedSidebandSession) return;
    postSideband('respond', { sessionId: selectedSidebandSession.sessionId }, 'Response triggered');
  };

  const handleInject = async () => {
    if (!selectedSidebandSession || !injectText.trim()) return;
    const ok = await postSideband('inject', {
      sessionId: selectedSidebandSession.sessionId,
      text: injectText.trim(),
      role: injectRole,
      respond: injectRespond,
    }, `Injected ${injectRole} message`);
    if (ok) {
      setShowInjectModal(false);
      setInjectText('');
      setInjectRespond(false);
    }
  };

  const handleDisconnectSideband = async (sessionId: string) => {
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
    } catch (error: unknown) {
      console.error('Error disconnecting:', error);
      toast.error('Failed to disconnect');
    }
  };

  const formatDuration = (seconds: number): string => {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const getTimeSince = (timestamp: string | null): string => {
    if (!timestamp) return 'Never';
    const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  const getCrisisBadgeClasses = (severity: string): string => {
    const badges: Record<string, string> = {
      high: 'bg-red-600 text-white animate-pulse',
      medium: 'bg-yellow-500 text-yellow-900',
      low: 'bg-orange-400 text-orange-900'
    };
    return badges[severity] || 'bg-gray-400 text-gray-900';
  };

  const getAlertBannerClasses = (severity: string): string => {
    const classes: Record<string, string> = {
      high: 'bg-red-100 border-red-500 text-red-900',
      medium: 'bg-yellow-100 border-yellow-500 text-yellow-900',
      low: 'bg-orange-100 border-orange-500 text-orange-900'
    };
    return classes[severity] || 'bg-gray-100 border-gray-500 text-gray-900';
  };

  const handleEndSession = async (sessionId: string, username: string | null) => {
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
    } catch (err: unknown) {
      console.error('Failed to end session:', err);
      toast.error(`Failed to end session: ${err instanceof Error ? err.message : 'Unknown error'}`);
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

  // Live transcript for the selected session.
  const selectedTranscript = selectedSidebandSession
    ? (transcripts[selectedSidebandSession.sessionId] || [])
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
          <h2 className="text-2xl font-bold text-navy">Live Session Monitoring</h2>
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
            className="px-4 py-2 bg-royal text-white rounded hover:bg-navy transition min-h-[44px]"
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
              <p className="text-3xl font-bold text-navy mt-1">{activeSessions.length}</p>
            </div>
            <Activity size={32} className="text-royal" aria-hidden="true" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg shadow" role="status" aria-live="polite">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Messages</p>
              <p className="text-3xl font-bold text-navy mt-1">
                {activeSessions.reduce((sum, s) => sum + parseInt(String(s.message_count || 0)), 0)}
              </p>
            </div>
            <MessageSquare size={32} className="text-royal" aria-hidden="true" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg shadow" role="status" aria-live="polite">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Users</p>
              <p className="text-3xl font-bold text-navy mt-1">
                {new Set(activeSessions.map(s => s.user_id)).size}
              </p>
            </div>
            <Users size={32} className="text-royal" aria-hidden="true" />
          </div>
        </div>

        <div className={`p-4 rounded-lg shadow ${crisisCount > 0 ? 'bg-red-50' : 'bg-white'}`} role="status" aria-live="assertive">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Crisis Sessions</p>
              <p className={`text-3xl font-bold mt-1 ${crisisCount > 0 ? 'text-red-600' : 'text-navy'}`}>
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
            <thead className="bg-navy text-white">
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
                  (Date.now() - new Date(session.last_activity).getTime()) < 30000; // 30s

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
                          <span className={`px-2 py-1 rounded text-xs font-semibold uppercase ${getCrisisBadgeClasses(session.crisis_severity ?? '')}`}>
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
                      {formatDuration(
                        session.status === 'active'
                          ? Math.max(0, Math.floor((nowTick - new Date(session.created_at).getTime()) / 1000))
                          : session.duration_seconds
                      )}
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
                          className="px-3 py-1 bg-royal text-white rounded hover:bg-navy transition text-sm min-h-[44px]"
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
              <Radio size={24} className="text-royal" />
              <div>
                <h3 className="text-xl font-bold text-navy">Sideband Connections</h3>
                <p className="text-sm text-gray-600">Server-side WebSocket connections to OpenAI Realtime API</p>
              </div>
            </div>
            <button
              onClick={() => socket?.emit('admin:get-sideband-connections')}
              className="px-4 py-2 bg-royal text-white rounded hover:bg-navy transition text-sm min-h-[44px]"
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
              <h4 className="font-semibold text-navy mb-3">
                Connection Attempts ({sidebandConnections.length})
              </h4>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {sidebandConnections.map(conn => (
                  <button
                    key={conn.sessionId}
                    onClick={() => setSelectedSidebandSession(conn)}
                    className={`w-full text-left p-3 rounded-lg transition ${
                      selectedSidebandSession?.sessionId === conn.sessionId
                        ? 'bg-royal text-white'
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
                    <h4 className="font-semibold text-navy">
                      Session: {selectedSidebandSession.sessionId.substring(0, 16)}...
                    </h4>
                    <div className="flex flex-wrap gap-2 justify-end">
                      <button
                        onClick={() => listeningSessionId === selectedSidebandSession.sessionId
                          ? stopListening()
                          : startListening(selectedSidebandSession.sessionId)}
                        title="Listen to the assistant's audio live"
                        className={`px-3 py-1.5 text-white rounded transition text-sm min-h-[44px] ${
                          listeningSessionId === selectedSidebandSession.sessionId
                            ? 'bg-emerald-600 hover:bg-emerald-700 animate-pulse'
                            : 'bg-gray-600 hover:bg-gray-700'
                        }`}
                      >
                        {listeningSessionId === selectedSidebandSession.sessionId ? '🔊 Listening' : '🔊 Listen'}
                      </button>
                      <button
                        onClick={handleInterrupt}
                        title="Cancel the in-progress response and clear buffered audio"
                        className="px-3 py-1.5 bg-orange-500 text-white rounded hover:bg-orange-600 transition text-sm min-h-[44px]"
                      >
                        ⏹ Interrupt
                      </button>
                      <button
                        onClick={() => setShowInjectModal(true)}
                        title="Inject a system or user message into the live conversation"
                        className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition text-sm min-h-[44px]"
                      >
                        💬 Inject
                      </button>
                      <button
                        onClick={handleForceResponse}
                        title="Force the AI to respond now"
                        className="px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 transition text-sm min-h-[44px]"
                      >
                        ▶ Respond
                      </button>
                      <button
                        onClick={() => setShowUpdateModal(true)}
                        className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 transition text-sm min-h-[44px]"
                      >
                        Update Config
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

                  {/* Live transcript — streamed from the sideband, no refresh */}
                  <div className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <h5 className="font-medium text-gray-700 text-sm">Live Transcript</h5>
                      <span className="flex items-center gap-1 text-xs text-green-600">
                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        live
                      </span>
                    </div>
                    <div ref={transcriptScrollRef} className="bg-white border border-gray-200 rounded p-3 max-h-80 overflow-y-auto space-y-2">
                      {selectedTranscript.length === 0 ? (
                        <p className="text-gray-400 text-sm italic">Waiting for speech…</p>
                      ) : (
                        selectedTranscript.map((turn) => (
                          <div
                            key={turn.itemId}
                            className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}
                          >
                            <div
                              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                                turn.role === 'user'
                                  ? 'bg-royal text-white rounded-br-none'
                                  : 'bg-gray-100 text-gray-900 rounded-bl-none'
                              }`}
                            >
                              <div className={`text-[10px] uppercase tracking-wide mb-0.5 ${turn.role === 'user' ? 'text-blue-100' : 'text-gray-500'}`}>
                                {turn.role === 'user' ? 'Participant' : 'AI'}
                              </div>
                              <span>{turn.text}</span>
                              {!turn.final && <span className="inline-block ml-1 animate-pulse">▍</span>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="mb-2">
                    <h5 className="font-medium text-gray-700 text-sm mb-2">
                      Events &amp; Tool Calls ({selectedSidebandEvents.length})
                    </h5>
                  </div>

                  <div className="bg-gray-50 rounded p-3 max-h-96 overflow-y-auto">
                    {selectedSidebandEvents.length === 0 ? (
                      <p className="text-gray-500 text-sm italic">No events yet</p>
                    ) : (
                      <div className="space-y-2">
                        {selectedSidebandEvents.map((event, idx) => {
                          if (event.type === 'tool_call') {
                            const td = event.data as { toolName?: string; status?: string; args?: unknown; result?: unknown; error?: string };
                            const status = td.status || 'executing';
                            const style = status === 'completed'
                              ? 'bg-green-50 border-green-500'
                              : status === 'failed'
                                ? 'bg-red-50 border-red-500'
                                : 'bg-purple-50 border-purple-500';
                            return (
                              <div key={idx} className={`p-2 rounded text-xs border-l-2 ${style}`}>
                                <div className="flex justify-between items-center mb-1">
                                  <span className="font-semibold text-gray-900">🔧 {td.toolName} · {status}</span>
                                  <span className="text-gray-500">{new Date(event.timestamp).toLocaleTimeString()}</span>
                                </div>
                                {td.args !== undefined && (
                                  <pre className="text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-words">args: {JSON.stringify(td.args, null, 2)}</pre>
                                )}
                                {td.result !== undefined && (
                                  <pre className="text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-words">result: {JSON.stringify(td.result, null, 2)}</pre>
                                )}
                                {td.error && (
                                  <pre className="text-xs text-red-700 overflow-x-auto whitespace-pre-wrap break-words">error: {td.error}</pre>
                                )}
                              </div>
                            );
                          }
                          return (
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
                          );
                        })}
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

      {/* Update Config Modal */}
      {showUpdateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-navy">Update Session Config</h3>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={advancedConfigMode}
                  onChange={(e) => setAdvancedConfigMode(e.target.checked)}
                />
                Advanced (raw JSON)
              </label>
            </div>

            {advancedConfigMode ? (
              <>
                <p className="text-gray-600 text-sm mb-4">
                  Paste a <code>session</code> config object. Any RealtimeSession field is allowed:
                  <code> instructions</code>, <code>tools</code>, <code>tool_choice</code>, <code>temperature</code>, <code>turn_detection</code>.
                  Sent as a live <code>session.update</code>.
                </p>
                <textarea
                  value={advancedConfigText}
                  onChange={(e) => setAdvancedConfigText(e.target.value)}
                  placeholder={'{\n  "temperature": 0.6,\n  "tool_choice": "auto"\n}'}
                  className="w-full min-h-[200px] p-3 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-royal resize-vertical"
                />
              </>
            ) : (
              <>
                <p className="text-gray-600 text-sm mb-4">
                  Update the AI instructions for this session in real-time via the sideband connection.
                  This will modify how the AI behaves without ending the session.
                </p>
                <textarea
                  value={updateInstructions}
                  onChange={(e) => setUpdateInstructions(e.target.value)}
                  placeholder="Enter new instructions for the AI therapist..."
                  className="w-full min-h-[200px] p-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-royal resize-vertical"
                />
              </>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowUpdateModal(false);
                  setUpdateInstructions('');
                  setAdvancedConfigText('');
                  setAdvancedConfigMode(false);
                }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateSession}
                disabled={advancedConfigMode ? !advancedConfigText.trim() : !updateInstructions.trim()}
                className={`px-4 py-2 rounded transition min-h-[44px] ${
                  (advancedConfigMode ? advancedConfigText.trim() : updateInstructions.trim())
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

      {/* Inject Message Modal */}
      {showInjectModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <h3 className="text-xl font-bold text-navy mb-4">Inject Message</h3>
            <p className="text-gray-600 text-sm mb-4">
              Insert a message into the live conversation context. A <strong>system</strong> message is a
              private steer (the participant won't see it as a turn); a <strong>user</strong> message acts as
              the participant.
            </p>

            <div className="flex flex-wrap items-center gap-4 mb-3">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                Role:
                <select
                  value={injectRole}
                  onChange={(e) => setInjectRole(e.target.value as 'system' | 'user')}
                  className="border border-gray-300 rounded px-2 py-1 text-sm"
                >
                  <option value="system">system (private steer)</option>
                  <option value="user">user (as participant)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={injectRespond}
                  onChange={(e) => setInjectRespond(e.target.checked)}
                />
                Make AI respond immediately
              </label>
            </div>

            <textarea
              value={injectText}
              onChange={(e) => setInjectText(e.target.value)}
              placeholder="Message to inject..."
              className="w-full min-h-[140px] p-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-royal resize-vertical"
            />

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowInjectModal(false);
                  setInjectText('');
                  setInjectRespond(false);
                }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleInject}
                disabled={!injectText.trim()}
                className={`px-4 py-2 rounded transition min-h-[44px] ${
                  injectText.trim()
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                }`}
              >
                Inject
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
