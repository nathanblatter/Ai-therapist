import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import ChatLog from "./ChatLog";
import SessionControls from "./SessionControls";
import SessionSettings from "./SessionSettings";
import PreSessionCheckIn, { type CheckinData } from "./PreSessionCheckIn";
import ConsentScreen from "./ConsentScreen";
import ExerciseOverlay, { type ActiveExercise } from "./ExerciseOverlay";
import ToolOverlays, { type ToolUI, type SafetyPlanData } from "./ToolOverlays";
import PostSessionScreen, { type PostSessionData, type SessionRecapData, type SharedWriteup } from "./PostSessionScreen";
import Header from './Header';
import VoiceOrb from './VoiceOrb';
import { initializeLogger } from '../utils/logger';
import ToastContainer, { toast } from '../../shared/components/Toast';
import BugReport from './BugReport';
import DemoSwitcher from '../../shared/components/DemoSwitcher';
import { startMixedTee, type AudioTeeHandle } from '../lib/audioTee';
import { createAudioUploader, type AudioUploader } from '../lib/audioUploader';
import { createParticipantSocket } from '../lib/participantSocket';
import { getStoredTheme, setTheme } from '../../shared/theme';
import { reportClientEvent } from '../utils/telemetry';

interface CrisisContact {
  hotline: string;
  phone: string;
  text: string;
  enabled: boolean;
}

interface Features {
  output_modalities: string[];
  voice_enabled: boolean;
  chat_enabled: boolean;
  session_recording_enabled?: boolean;
}

interface SessionSettings {
  voice: string;
  language: string;
}

interface ChatMessage {
  id: string;
  role: string;
  text: string;
  isAdminMessage?: boolean;
}

interface LogRecord {
  timestamp: string;
  sessionId: string | null;
  role: string;
  type: string;
  message: string | null;
  extras: unknown;
}

interface LogConversationParams {
  sessionId: string | null;
  role: string;
  type: string;
  message: string;
  extras?: unknown;
  extra?: unknown;
}

export default function App() {
  const [isClient, setIsClient] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState<unknown[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantStream, setAssistantStream] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const assistantBuffer = useRef("");
  const userBuffer = useRef("");
  const currentVoiceMessageId = useRef<string | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  // Always-on capture: tee mixes mic+assistant audio; uploader POSTs it to the
  // server (HTTP, since the participant socket is unreliable through the tunnel).
  const audioTeeRef = useRef<AudioTeeHandle | null>(null);
  const audioUploaderRef = useRef<AudioUploader | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Latest-ref for stopSession (ai-therapist-113): the WebRTC data-channel
  // handler is attached once inside startRealtimeSession, closing over THAT
  // render's stopSession — in which sessionId state is still null. Calling it
  // directly made model-initiated end_session silently skip the POST /end
  // (and the session_end log, and the post-session snapshot). Handlers must
  // go through this ref so they always get the current-render closure.
  const stopSessionRef = useRef<() => Promise<void>>(async () => {});
  const [sessionSettings, setSessionSettings] = useState<SessionSettings>({
    voice: 'cedar',
    language: 'en'
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCheckInOpen, setIsCheckInOpen] = useState(false);
  const [activeExercise, setActiveExercise] = useState<ActiveExercise | null>(null);
  const [toolUI, setToolUI] = useState<ToolUI | null>(null);
  // Artifacts the participant chose to keep/share during the session, for
  // "Download my work" (ai-therapist-76) — never the raw transcript.
  const [sessionRecap, setSessionRecap] = useState<SessionRecapData | null>(null);
  const [sessionSafetyPlan, setSessionSafetyPlan] = useState<SafetyPlanData | null>(null);
  const [sessionWriteups, setSessionWriteups] = useState<SharedWriteup[]>([]);
  // Snapshot shown on the post-session screen (ai-therapist-25b / 76) after
  // stopSession() clears the live session state.
  const [postSessionData, setPostSessionData] = useState<PostSessionData | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [crisisContact, setCrisisContact] = useState<CrisisContact>({
    hotline: '988 Suicide & Crisis Lifeline',
    phone: '988',
    text: 'HELLO to 741741',
    enabled: true
  });
  const [features, setFeatures] = useState<Features>({
    output_modalities: ["audio"],
    voice_enabled: true,
    chat_enabled: true
  });
  const [sessionEndTime, setSessionEndTime] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Wrap-up state (ai-therapist-101/112): when the client countdown hits zero
  // in a realtime session, the mic locks and we WAIT for the server-driven
  // close (model wrap-up → end_session, or the server hard-end) instead of
  // tearing the call down mid-sentence. The failsafe covers the worst case
  // where neither ever arrives.
  const [micLocked, setMicLocked] = useState(false);
  const wrapUpFailsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionType, setSessionType] = useState<string | null>(null); // 'realtime' or 'chat'

  // Start-flow feedback (ai-therapist-117): true from the moment the
  // participant confirms the check-in until the data channel opens (realtime)
  // or the chat session is created — drives the "Connecting..." state on the
  // Start button and guards against double-clicks. Always cleared on error.
  const [isConnecting, setIsConnecting] = useState(false);
  // Early rate-limit check: fetched on mount so participants learn they've
  // hit the daily cap BEFORE going through consent + check-in.
  const [rateLimitInfo, setRateLimitInfo] = useState<{ limited: boolean; resetsAt: string | null }>({
    limited: false,
    resetsAt: null,
  });
  // Debounce for WebRTC 'disconnected' (it can self-heal); 'failed' acts immediately.
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Consent (ai-therapist-24): must be accepted before a session can start.
  const [isConsentOpen, setIsConsentOpen] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentVersion, setConsentVersion] = useState('');
  const [consentBody, setConsentBody] = useState('');
  const [reconsentRequired, setReconsentRequired] = useState(false);

  useEffect(() => {
    setIsClient(true);

    // Initialize logger first (controls console.log output)
    initializeLogger();

    // Fetch crisis contact info
    fetch('/api/config/crisis')
      .then(res => res.json())
      .then(data => setCrisisContact(data))
      .catch(err => console.error('Failed to fetch crisis contact:', err));

    // Fetch daily-session rate-limit status so a capped participant sees the
    // limit up front instead of after consent + check-in (429 on /token).
    fetch('/api/rate-limits/status', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data && data.is_rate_limited) {
          setRateLimitInfo({ limited: true, resetsAt: data.limit_resets_at ?? null });
        }
      })
      .catch(err => console.error('Failed to fetch rate limit status:', err));

    // Fetch features config
    fetch('/api/config/features')
      .then(res => res.json())
      .then(data => setFeatures(data))
      .catch(err => console.error('Failed to fetch features config:', err));

    // Fetch consent status: has this browser session already accepted the
    // current consent copy? (e.g. earlier in the same session, or a returning
    // logged-in user within the same cookie's lifetime).
    fetch('/api/consent/status', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setConsentVersion(data.currentVersion);
        setConsentAccepted(!!data.accepted);
        setConsentBody(data.body ?? '');
        setReconsentRequired(!!data.reconsentRequired);
      })
      .catch(err => console.error('Failed to fetch consent status:', err));

    // Fetch user preferences (voice and language)
    fetch('/api/users/preferences', {
      credentials: 'include'
    })
      .then(res => {
        if (res.ok) {
          return res.json();
        }
        // If not authenticated or error, use defaults
        return { voice: 'cedar', language: 'en' };
      })
      .then(prefs => {
        setSessionSettings({
          voice: prefs.voice || 'cedar',
          language: prefs.language || 'en'
        });
        // Server-stored theme wins over this device's localStorage so a
        // logged-in user's choice follows them across devices.
        if (prefs.theme && prefs.theme !== getStoredTheme()) {
          setTheme(prefs.theme);
        }
        console.log('Loaded user preferences:', prefs);
      })
      .catch(err => {
        console.error('Failed to fetch user preferences:', err);
        // Keep defaults on error
      });
  }, []);

  // Session countdown timer
  useEffect(() => {
    if (!sessionEndTime || !isSessionActive) {
      // Clear timer if no session or session ended
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setTimeRemaining(null);
      return;
    }

    // Update countdown every second
    timerIntervalRef.current = setInterval(() => {
      const remaining = sessionEndTime - Date.now();

      if (remaining <= 0) {
        setTimeRemaining(0);
        clearInterval(timerIntervalRef.current!);
        timerIntervalRef.current = null;

        if (sessionType === 'chat') {
          // Chat has no server-driven wrap-up; end it here as before.
          toast.warning("Your session time has ended. The session will now close.");
          stopSession();
          return;
        }

        // Realtime (ai-therapist-101/112): the SERVER clock is authoritative.
        // It has already asked the model (over the sideband) to give a warm
        // closing and call end_session, with a hard end as backstop. Tearing
        // down here used to cut the assistant off mid-sentence. Lock the mic
        // so no new participant turns start, and let the wrap-up land.
        toast.warning("Time's up — the session is wrapping up and will close in a moment.");
        setMicLocked(true);
        peerConnection.current?.getSenders().forEach(sender => {
          if (sender.track) sender.track.enabled = false;
        });
        // Failsafe: if neither the model's end_session nor the server's hard
        // end ever reaches us, close locally rather than hanging forever.
        wrapUpFailsafeRef.current = setTimeout(() => void stopSession(), 120 * 1000);
      } else {
        setTimeRemaining(remaining);
      }
    }, 1000);

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [sessionEndTime, isSessionActive, sessionType]);

  // ---- Batched logger ----
  const logBufferRef = useRef<LogRecord[]>([]);
  const flushInFlightRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const FLUSH_SIZE = 200;
  const FLUSH_INTERVAL_MS = 15000;

  function logConversation({ sessionId, role, type, message, extras }: LogConversationParams) {
    if (!sessionId || !type) return;
    logBufferRef.current.push({
      timestamp: new Date().toISOString(),
      sessionId,
      role: role || "system",
      type,
      message: message ?? null,
      extras: extras ?? null,
    });
    if (logBufferRef.current.length >= FLUSH_SIZE) void flushLogs();
  }

  async function flushLogs() {
    if (flushInFlightRef.current) return;
    const batch = logBufferRef.current;
    if (!batch.length) return;
    flushInFlightRef.current = true;
    logBufferRef.current = [];
    try {
      await fetch("/logs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: batch }),
        keepalive: true,
      });
    } catch (err) {
      console.error("Failed to batch log, re-queueing:", err);
      logBufferRef.current = [...batch, ...logBufferRef.current];
    } finally {
      flushInFlightRef.current = false;
    }
  }

  function startPeriodicFlush() {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setInterval(() => void flushLogs(), FLUSH_INTERVAL_MS);
  }
  function stopPeriodicFlush() {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }

  // Wrapper function that routes to realtime or chat-only based on features.
  // Any failure on the start path (mic permission, token fetch, SDP exchange)
  // lands here: show a specific toast and always re-enable the Start button
  // instead of failing silently (ai-therapist-117).
  async function startSession(checkin: CheckinData | null = null) {
    setPostSessionData(null); // clear the previous session's post-session screen
    setIsConnecting(true);
    try {
      if (features.voice_enabled === false) {
        await startChatSession(checkin);
        // Chat has no data channel; the session is live once the fetch returns.
        setIsConnecting(false);
      } else {
        await startRealtimeSession(checkin);
        // isConnecting stays true until the data channel opens (or an early
        // return inside startRealtimeSession already cleared it).
      }
    } catch (error) {
      console.error('Failed to start session:', error);
      const name = error instanceof DOMException || error instanceof Error ? error.name : '';
      const errMessage = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      if (name === 'NotAllowedError' || name === 'NotFoundError') {
        toast.error('We could not access your microphone. Please allow microphone access in your browser settings (or plug one in) and try again.');
        reportClientEvent('mic_permission_denied', { name });
      } else {
        toast.error('Could not start your session — there was a problem reaching the server. Please check your connection and try again.');
        reportClientEvent(name === 'SdpFetchError' ? 'sdp_fetch_failed' : 'webrtc_failed', { stage: 'start', name, message: errMessage });
      }
      setIsConnecting(false);
      // Best-effort teardown of whatever the failed start left behind
      // (socket, peer connection, mic track) so the next attempt is clean.
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (dataChannelRef.current) {
        dataChannelRef.current.close();
        dataChannelRef.current = null;
      }
      if (peerConnection.current) {
        peerConnection.current.getSenders().forEach((sender) => {
          if (sender.track) sender.track.stop();
        });
        peerConnection.current.close();
        peerConnection.current = null;
      }
      setLocalStream(null);
      setSessionId(null);
      setSessionType(null);
      setSessionEndTime(null);
      setTimeRemaining(null);
    }
  }

  // Chat-only therapy session (GPT-4 text completions)
  async function startChatSession(checkin: CheckinData | null = null) {
    try {
      // Send the current language picker value (request body wins server-side)
      // so it also applies for anonymous participants without saved prefs.
      const response = await fetch('/api/chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: sessionSettings.language, checkin })
      });

      // Check for rate limiting errors
      if (response.status === 429) {
        const errorData = await response.json();
        toast.error(errorData.message || "You have reached your session limit. Please try again later.");
        console.warn("Rate limit exceeded:", errorData);
        setRateLimitInfo({ limited: true, resetsAt: errorData.limit_resets_at ?? null });
        return;
      }

      const data = await response.json();
      console.log("Chat session started:", data);

      // Check if session already exists (idempotency check)
      if (data.alreadyActive) {
        toast.warning("You already have an active session. Please end it before starting a new one.");
        console.warn("Active session already exists:", data.sessionId);
        return;
      }

      const newSessionId = data.sessionId;
      setSessionId(newSessionId);
      setSessionType('chat');
      setIsSessionActive(true);

      // Connect to Socket.io for remote session management
      const socket = createParticipantSocket(newSessionId, 'chat');

      socket.on('session:status', (data) => {
        console.log('Received session:status event:', data);
        if (data.status === 'ended' && data.remoteTermination) {
          toast.warning(`Your session has been remotely ended by ${data.endedBy}. The session will now close.`);
          stopSession();
        }
      });

      socketRef.current = socket;

      // Add preamble message to chat (similar to realtime voice therapy)
      setMessages([{
        id: crypto.randomUUID(),
        role: "assistant",
        text: getPreambleForLanguage(sessionSettings.language, false),
      }]);

      console.log(`Chat-only session started: ${newSessionId}`);

    } catch (error) {
      console.error('Failed to start chat session:', error);
      toast.error('Failed to start chat session. Please try again.');
      reportClientEvent('chat_send_failed', { where: 'start', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }
  }

  // Realtime therapy session (WebRTC with voice + chat)
  async function startRealtimeSession(checkin: CheckinData | null = null) {
    // Get a session token for OpenAI Realtime API. The current picker values
    // are sent explicitly (request body wins server-side) so the choice also
    // applies for anonymous participants, who have no saved preferences row;
    // logged-in users' preferences remain the fallback when nothing is sent.
    const tokenResponse = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice: sessionSettings.voice,
        language: sessionSettings.language,
        checkin,
      })
    });

    // Check for rate limiting errors
    if (tokenResponse.status === 429) {
      const errorData = await tokenResponse.json();
      toast.error(errorData.message || "You have reached your session limit. Please try again later.");
      console.warn("Rate limit exceeded:", errorData);
      setRateLimitInfo({ limited: true, resetsAt: errorData.limit_resets_at ?? null });
      setIsConnecting(false);
      return;
    }

    if (!tokenResponse.ok) {
      throw new Error(`Token request failed with status ${tokenResponse.status}`);
    }

    const data = await tokenResponse.json();
    console.log("Session token data:", data);

    // Check if session already exists (idempotency check)
    if (data.session?.exists) {
      toast.warning(data.message || "You already have an active session. Please end it before starting a new one.");
      console.warn("Active session already exists:", data.session.id);
      setIsConnecting(false);
      return; // Don't proceed with session creation
    }

    const EPHEMERAL_KEY = data.value;
    const newSessionId = data.session.id;
    setSessionId(newSessionId);
    setSessionType('realtime');

    // Set up session timer if duration limit exists
    if (data.session_limits && data.session_limits.max_duration_minutes) {
      const durationMs = data.session_limits.max_duration_minutes * 60 * 1000;
      const endTime = Date.now() + durationMs;
      setSessionEndTime(endTime);
      setTimeRemaining(durationMs);
      console.log(`Session will end in ${data.session_limits.max_duration_minutes} minutes`);
    }

    // Connect to Socket.io for remote session management. The participant
    // socket is known to be unreliable through the tunnel (ai-therapist-18);
    // audio doesn't depend on it (uploaded over plain HTTP) and abandonment
    // is also handled server-side independent of a clean disconnect (see
    // sessionLifecycle.service.ts) — this socket is only used for
    // remote-termination notices and live crisis messages.
    const socket = createParticipantSocket(newSessionId, 'realtime');

    // Audio capture is started in pc.ontrack below (once both the mic and the
    // assistant track exist) and runs for the whole session so the server can
    // record it and relay it live to any admin who chooses to listen.

    // Listen for remote session termination by admin or system
    socket.on('session:status', (data) => {
      console.log('Received session:status event:', data);
      if (data.status === 'ended' && data.remoteTermination) {
        if (data.endedBy === 'system' && data.reason === 'duration_limit') {
          toast.warning(data.message || 'Your session has ended due to time limit.');
        } else {
          toast.warning(`Your session has been remotely ended by ${data.endedBy}. The session will now close.`);
        }
        stopSession();
      }
    });

    // Age-eligibility end (ai-therapist-106): the participant disclosed being a
    // minor. The server has injected goodbye guidance to the model and will
    // force-end the session after a short grace; the client closes its own
    // end-session flow (same family as the remote-termination notice above).
    socket.on('session:eligibility-end', () => {
      toast.warning('This study is only open to adults 18 and older, so this session is ending. Take good care.');
      stopSession();
    });

    // Listen for crisis intervention messages
    socket.on('messages:new', (data) => {
      console.log('[Crisis] Received messages:new event:', data);
      console.log('[Crisis] DataChannel state:', dataChannelRef.current ? dataChannelRef.current.readyState : 'null');

      // Handle both array and single object formats
      const messages = Array.isArray(data) ? data : [data];

      messages.forEach(msg => {
        // Handle AI guidance messages (hidden from user, sent to AI)
        if (msg.message_type === 'ai_guidance' && msg.metadata?.hidden_from_user) {
          console.log('[Crisis] Sending AI guidance to OpenAI');
          sendInvisiblePrompt(msg.content);
        }
        // Crisis intervention and admin messages: send to AI to speak them
        else if (msg.message_type === 'crisis_intervention' || msg.message_type === 'crisis_emergency' || msg.message_type === 'admin_visible') {
          console.log('[Crisis] Sending intervention message to AI to speak:', msg.content.substring(0, 100));
          // Escape single quotes in the message content
          const escapedContent = msg.content.replace(/'/g, "\\'");
          // Wrap in "Say this phrase exactly" format so AI speaks it
          const promptToSpeak = `Say this phrase exactly: '${escapedContent}'`;

          // Retry sending if data channel isn't ready yet
          const trySendMessage = (attempt = 0) => {
            const maxAttempts = 10;
            if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
              console.log('[Crisis] DataChannel is open, sending message');
              sendInvisiblePrompt(promptToSpeak);
            } else if (attempt < maxAttempts) {
              const state = dataChannelRef.current ? dataChannelRef.current.readyState : 'null';
              console.log(`[Crisis] DataChannel not ready (${state}), retry ${attempt + 1}/${maxAttempts} in 500ms`);
              setTimeout(() => trySendMessage(attempt + 1), 500);
            } else {
              console.error('[Crisis] Failed to send message after max retries - data channel never opened');
            }
          };

          trySendMessage();

          // Also display in chat log
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              text: msg.content
            }
          ]);
        }
      });
    });

    // Listen for admin messages during active session
    socket.on('admin:message', (data) => {
      console.log('Received admin message:', data);
      console.log('[Admin] DataChannel state:', dataChannelRef.current ? dataChannelRef.current.readyState : 'null');
      const { message, messageType, senderName } = data;

      if (messageType === 'visible') {
        console.log('[Admin] Received visible message:', message);

        // Display message to user only — do NOT forward to the bot
        const fullMessage = `[Message from ${senderName}]: ${message}`;
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            text: fullMessage,
            isAdminMessage: true
          }
        ]);
      } else if (messageType === 'invisible') {
        // Send as invisible prompt to AI (guides AI response without user seeing it)
        if (dataChannelRef.current) {
          const event = {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: message,
                },
              ],
            },
          };
          dataChannelRef.current.send(JSON.stringify(event));
          dataChannelRef.current.send(JSON.stringify({ type: "response.create" }));

          // Log the invisible prompt
          logConversation({
            sessionId: newSessionId,
            role: "system",
            type: "admin_invisible",
            message: `Admin invisible prompt: ${message}`
          });
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket.io disconnected');
    });

    socketRef.current = socket;

    const trimmedData = {
      ...data.session,
      
      instructions: "[[ OMITTED FOR LOGGING ]]",
      
      
     
    };

    logConversation({
      sessionId: trimmedData.id,
      role: "system",
      type: "session_start",
      message: "Session started",
    });
    logConversation({
      sessionId: trimmedData.id,
      role: "system",
      type: "system",
      message: "Session settings",
      extras: trimmedData, // This will include trimmed session metadata
    });
    // Create a peer connection. Assigned to the ref immediately so a failure
    // later in the start path (mic permission, SDP exchange) can be torn down
    // from startSession()'s catch block.
    const pc = new RTCPeerConnection();
    peerConnection.current = pc;

    // Surface connection drops (ai-therapist-117): 'failed' ends the session
    // right away; 'disconnected' can self-heal, so give it a short grace
    // period before treating it as a drop. Either way the participant gets an
    // explanation and the post-session screen instead of a frozen orb.
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
      } else if (state === 'failed') {
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        toast.error('The connection to your session was lost. The session has ended — you can start a new one whenever you are ready.');
        reportClientEvent('webrtc_failed', { stage: 'connectionstatechange' }, newSessionId);
        void stopSessionRef.current();
      } else if (state === 'disconnected') {
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            disconnectTimerRef.current = null;
            const s = pc.connectionState;
            if (s === 'disconnected' || s === 'failed') {
              toast.error('The connection to your session was lost. The session has ended — you can start a new one whenever you are ready.');
              reportClientEvent('webrtc_disconnected', { stage: 'grace-period-expired', state: s }, newSessionId);
              void stopSessionRef.current();
            }
          }, 7000);
        }
      }
    };
    // Set up to play remote audio from the model
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioElement.current = audioEl;
    // Add local audio track for microphone input in the browser
    // Enable the browser's built-in mic DSP so steady background noise (fans,
    // hum, room tone) is suppressed before audio ever reaches the Realtime API.
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    setLocalStream(ms);
    pc.addTrack(ms.getTracks()[0]);

    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      setRemoteStream(e.streams[0]);
      // Capture the whole conversation: mix mic + assistant audio into one PCM
      // stream and upload it over HTTP for the entire session, so the server can
      // record it and relay it live to any admin who is listening. Gated on the
      // features.session_recording_enabled flag (also shown in the consent
      // screen the participant just accepted) — when it's off, capture never
      // starts and nothing is uploaded.
      if (!audioTeeRef.current && features.session_recording_enabled) {
        const uploader = createAudioUploader(newSessionId);
        audioUploaderRef.current = uploader;
        audioTeeRef.current = startMixedTee([ms, e.streams[0]], (pcm, sampleRate) => {
          uploader.push(pcm, sampleRate);
        });
      }
    };
    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    dataChannelRef.current = dc;
    dc.addEventListener("error", (e) => {
      console.error('[DataChannel] error:', e);
      reportClientEvent('data_channel_error', { stage: 'oai-events' }, newSessionId);
    });

    // Set up data channel event listeners
    dc.addEventListener("message", async (e) => {
      const event = JSON.parse(e.data);
      console.log(event)
      if (!event.timestamp) {
        event.timestamp = new Date().toLocaleTimeString();
      }

      if (event.type === 'response.function_call_arguments.done') {
        const fn = (fns as Record<string, ((args: unknown) => Promise<unknown>) | undefined>)[event.name as string];
        if (fn !== undefined) {
          const args = JSON.parse(event.arguments as string);
          const result = await fn(args);
          logConversation({ sessionId: newSessionId, role: "system", type: "function_call", message: `Function ${event.name as string} called`, extras: { args, result } });
        }
      }

      if (event.type && event.type.startsWith("response")) {
        if (event.response && event.response.output) {
          (event.response.output as Array<{ type: string; text?: string }>).forEach((out) => {
            if (out.type === "text") {
              assistantBuffer.current += out.text;
              setAssistantStream(assistantBuffer.current.trim());
            }
          });
        }

        if (event.type === "response.content_part.done") {
          if (event.part?.type === "audio" && event.part.transcript) {
            const assistantMessage = event.part.transcript.trim();
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "assistant", text: assistantMessage },
            ]);
            assistantBuffer.current = "";
            setAssistantStream("");
            logConversation({
              sessionId: newSessionId,
              role: "assistant",
              type: "response",
              message: assistantMessage,
            });
          }
        }
      }

      if (event.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = event.transcript;
        if (transcript) {
          const id = crypto.randomUUID();
          setMessages((prev) => [
            ...prev,
            { id, role: "user", text: transcript.trim() }
          ]);
          logConversation({ sessionId: newSessionId, role: "user", type: "voice", message: transcript.trim() });
        }
      }
      setEvents((prev) => [event, ...prev]);
    });

    dc.addEventListener("open", () => {
      console.log('[DataChannel] Channel opened');
      setIsConnecting(false);
      setIsSessionActive(true);
      setEvents([]);
      setMessages([]);
      setAssistantStream("");
      startPeriodicFlush();

      const initialPrompt = getInitialPromptForLanguage(sessionSettings.language);
      sendInvisiblePrompt(initialPrompt, `Initial prompt: ${initialPrompt}`);
    });

    // Start the session using the Session Description Protocol (SDP)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Fetch AI model from system config
    const modelResponse = await fetch("/api/config/ai-model");
    const modelData = await modelResponse.json();
    const model = modelData.model || "gpt-realtime-2.1-mini"; // Fallback to default

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
    method: "POST",
    body: offer.sdp,
    headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
    },
});

    // Extract the call_id from the Location header so the server can attach a
    // sideband WebSocket to this same Realtime call (tools/monitoring/control).
    // Location format: /v1/realtime/calls/rtc_xxxxx
    const locationHeader = sdpResponse.headers.get('Location');
    const callId = locationHeader ? locationHeader.split('/').pop() : null;
    if (callId) {
      console.log(`[Sideband] Extracted call_id: ${callId}`);
    } else {
      // If this is null the header likely isn't CORS-exposed to the browser —
      // the server can't attach the sideband without it.
      console.warn('[Sideband] No readable Location header on the SDP response; sideband will not attach.');
    }

    // A non-2xx SDP answer means the Realtime call never came up. Name the
    // error so startSession()'s catch reports it as sdp_fetch_failed (rather
    // than a generic webrtc_failed) before showing the network-problem toast.
    if (!sdpResponse.ok) {
      const sdpError = new Error(`SDP exchange failed with status ${sdpResponse.status}`);
      sdpError.name = 'SdpFetchError';
      throw sdpError;
    }

    const answer: RTCSessionDescriptionInit = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await pc.setRemoteDescription(answer);

    // Hand the call_id to the server so it can open its sideband WebSocket — but
    // only once the WebRTC call is actually CONNECTED. Registering right after
    // setRemoteDescription races OpenAI: the session for the call_id doesn't
    // exist until negotiation finishes, which yields a 404 call_id_not_found.
    // Non-fatal: the voice session continues even if this fails.
    if (callId && newSessionId) {
      let registered = false;
      const registerSideband = async () => {
        if (registered) return;
        registered = true;
        try {
          const registerResponse = await fetch(`/api/sessions/${newSessionId}/register-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The server attaches its sideband WS with the standard API key
            // (per OpenAI's server-side-controls docs — ai-therapist-62). The
            // ephemeral key is still sent as a one-shot fallback in case the
            // standard key is rejected live. (This ephemeral secret originated
            // from our own /token endpoint.)
            body: JSON.stringify({ call_id: callId, ephemeral_key: EPHEMERAL_KEY })
          });

          if (registerResponse.ok) {
            console.log(`[Sideband] Registered call_id with server for session ${newSessionId}`);
          } else {
            const errorText = await registerResponse.text();
            console.warn('[Sideband] Failed to register call_id with server:', errorText);
          }
        } catch (error) {
          console.error('[Sideband] Error registering call_id:', error);
        }
      };

      if (pc.connectionState === 'connected') {
        registerSideband();
      } else {
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'connected') registerSideband();
        });
      }
    }
  }

  async function stopSession() {
    setActiveExercise(null);
    setToolUI(null);
    setMicLocked(false);
    setIsConnecting(false);
    if (wrapUpFailsafeRef.current) {
      clearTimeout(wrapUpFailsafeRef.current);
      wrapUpFailsafeRef.current = null;
    }
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (peerConnection.current) {
      peerConnection.current.onconnectionstatechange = null;
    }

    // Snapshot what the participant chose to keep/share before clearing
    // per-session state, so the post-session screen (recap + safety plan +
    // "download my work") has something to show (ai-therapist-25b/76).
    if (sessionId) {
      setPostSessionData({
        sessionId,
        endedAt: new Date(),
        recap: sessionRecap,
        safetyPlan: sessionSafetyPlan,
        writeups: sessionWriteups,
      });
    }
    setSessionRecap(null);
    setSessionSafetyPlan(null);
    setSessionWriteups([]);

    // Handle chat-only session
    if (sessionType === 'chat') {
      if (sessionId) {
        try {
          await fetch('/api/chat/end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });
        } catch (error) {
          console.error('Failed to end chat session:', error);
        }
      }

      // Disconnect Socket.io
      if (socketRef.current) {
        if (sessionId) {
          socketRef.current.emit('session:leave', { sessionId });
        }
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      setIsSessionActive(false);
      setSessionId(null);
      setSessionType(null);
      setSessionEndTime(null);
      setTimeRemaining(null);
      return;
    }

    // Handle realtime session (original logic)
    logConversation({ sessionId:sessionId, role: "system", type: "session_end", message: "Session ended" });
    stopPeriodicFlush();
    await flushLogs();

    // Call the API to mark the session as ended and trigger session name generation
    if (sessionId) {
      try {
        await fetch(`/api/sessions/${sessionId}/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Failed to end session:', error);
      }
    }

    // Disconnect Socket.io
    if (socketRef.current) {
      if (sessionId) {
        socketRef.current.emit('session:leave', { sessionId });
      }
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    if (audioTeeRef.current) {
      audioTeeRef.current.stop();
      audioTeeRef.current = null;
    }
    if (audioUploaderRef.current) {
      audioUploaderRef.current.stop(); // flush the final batch
      audioUploaderRef.current = null;
    }

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    dataChannelRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setSessionId(null);
    setSessionType(null);
    setSessionEndTime(null);
    setTimeRemaining(null);
    peerConnection.current = null;
  }

  // Handle page unload - warn user and end session
  useEffect(() => {
    // Show warning dialog when user tries to leave during active session
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isSessionActive && sessionId) {
        // Show browser's built-in "Leave site?" dialog
        e.preventDefault();
        e.returnValue = 'You have an active therapy session. Leaving will end your session.';
        return e.returnValue;
      }
    };

    // Actually end the session when page is being unloaded
    const handlePageHide = () => {
      // Flush logs regardless of session state
      const logBlob = new Blob([JSON.stringify({ records: logBufferRef.current })], { type: 'application/json' });
      navigator.sendBeacon?.("/logs/batch", logBlob);

      // If session is active, end it
      if (isSessionActive && sessionId) {
        const endBlob = new Blob([JSON.stringify({ sessionId })], { type: 'application/json' });
        if (sessionType === 'chat') {
          navigator.sendBeacon?.("/api/chat/end", endBlob);
        } else {
          navigator.sendBeacon?.(`/api/sessions/${sessionId}/end`, endBlob);
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [isSessionActive, sessionId, sessionType]);


  function sendClientEvent(message: Record<string, unknown>) {
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = (message.event_id as string | undefined) || crypto.randomUUID();
      dataChannelRef.current.send(JSON.stringify(message));
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      const state = dataChannelRef.current ? dataChannelRef.current.readyState : 'null';
      console.error(`Failed to send message - data channel not ready (state: ${state})`, message);
    }
  }

  async function sendTextMessage(message: string) {
    // Handle chat-only session
    if (sessionType === 'chat') {
      // Add user message to UI immediately
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text: message },
      ]);

      try {
        const response = await fetch('/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message })
        });

        if (!response.ok) {
          throw new Error('Failed to send message');
        }

        const data = await response.json();

        // Add AI response to UI
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", text: data.response },
        ]);

        // Tool parity (ai-therapist-118): the server executes chat tool calls
        // and returns the visual ones as toolEvents; dispatch them through the
        // same fns map the realtime data channel drives so overlays (resource
        // card, safety plan, thought record, ...) render identically. Unknown
        // or teardown-related names are skipped gracefully.
        const toolEvents = (data.toolEvents ?? []) as Array<{ name: string; args?: unknown }>;
        for (const ev of toolEvents) {
          if (ev.name === 'end_session' || ev.name === 'stopSession') continue;
          const fn = (fns as Record<string, ((args: unknown) => Promise<unknown>) | undefined>)[ev.name];
          if (fn === undefined) continue;
          try {
            await fn(ev.args ?? {});
          } catch (err) {
            console.error(`[Chat] Failed to render tool overlay ${ev.name}:`, err);
          }
        }

        // Age-eligibility end (ai-therapist-106): the server ended the session
        // and authored the goodbye above. Run the normal teardown UI path
        // (stopSession re-POSTs /api/chat/end, which is idempotent).
        if (data.sessionEnded) {
          await stopSession();
        }

      } catch (error) {
        console.error('Failed to send chat message:', error);
        reportClientEvent('chat_send_failed', { where: 'message', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) }, sessionId);
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "system", text: "Error: Failed to send message. Please try again." },
        ]);
      }
      return;
    }

    // Handle realtime session (original logic)
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: message },
    ]);
    sendClientEvent({ type: "response.create" });
    logConversation({ sessionId:sessionId, role: "user", type: "chat", message: message });
  }

  function sendInvisiblePrompt(text: string, logMessage: string | null = null) {
    console.log('[sendInvisiblePrompt] Sending text:', text);
    console.log('[sendInvisiblePrompt] Text length:', text.length);

    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: text,
          },
        ],
      },
    };

    console.log('[sendInvisiblePrompt] Event:', JSON.stringify(event, null, 2));
    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
    // Only log if a custom log message is provided (for initial prompts)
    // Crisis intervention guidance messages are already logged server-side
    if (logMessage !== null) {
      logConversation({ sessionId:sessionId, role: "system", type: "system", message: logMessage });
    }
  }

  // Report a participant-side tool outcome (exercise finished, worksheet
  // done, journal kept private…) to the SERVER, which informs the live model
  // over the sideband — the reliable path (ai-therapist-112). The old
  // data-channel invisible prompt is kept only as the fallback for sessions
  // with no sideband (chat) or when the request fails.
  async function reportToolEvent(kind: string, summary: string) {
    try {
      // Both channels report server-side now: realtime injects over the
      // sideband; chat appends to the in-memory history so the outcome rides
      // the next turn (ai-therapist-118).
      if (sessionId && (sessionType === 'realtime' || sessionType === 'chat')) {
        const res = await fetch(`/api/sessions/${sessionId}/tool-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, summary }),
        });
        if (res.ok) {
          const data = await res.json() as { injected?: boolean };
          if (data.injected) return;
        }
      }
    } catch (err) {
      console.error('[reportToolEvent] server report failed, falling back to data channel:', err);
    }
    sendInvisiblePrompt(summary);
  }

  function getPreambleForLanguage(language: string, includeVoiceInstructions = true) {
    const crisisText = crisisContact.enabled
      ? `call the ${crisisContact.hotline} crisis line at ${crisisContact.phone}${crisisContact.text ? ' or text ' + crisisContact.text : ''}`
      : 'call 911 or your local emergency services';

    const voiceNote = includeVoiceInstructions
      ? ` Also, please note that your microphone is off by default. If you'd like to talk using voice, you'll need to press the red mic toggle button to turn it on.`
      : '';

    const basePrompt = `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. Please remember, if you're in crisis, you should ${crisisText}.${voiceNote} Thanks again for being willing to talk, I'm glad you're here with me today.`;

    return basePrompt;
  }

  function getInitialPromptForLanguage(language: string) {
    const basePrompt = getPreambleForLanguage(language, true);

    const languageNames: Record<string, string> = {
      'en': 'English',
      'es-ES': 'Spanish from Spain (Español de España)',
      'es-419': 'Latin American Spanish (Español Latinoamericano)',
      'fr-FR': 'French from France (Français de France)',
      'fr-CA': 'Québécois French (Français Québécois)',
      'pt-BR': 'Brazilian Portuguese (Português Brasileiro)',
      'pt-PT': 'European Portuguese (Português Europeu)',
      'de': 'German',
      'it': 'Italian',
      'zh': 'Chinese',
      'ja': 'Japanese',
      'ko': 'Korean',
      'ar': 'Arabic',
      'hi': 'Hindi',
      'ru': 'Russian'
    };

    if (language === 'en') {
      return `Say this phrase exactly: '${basePrompt}'`;
    } else {
      const langName = languageNames[language] || language;
      return `Say this phrase exactly in ${langName}: '${basePrompt}'`;
    }
  }

  // Client-side reactions to AI tool calls, dispatched from the WebRTC data
  // channel (the server sideband executes the canonical tool; these drive UI).
  // Keep the ref pointing at the freshest closure on every render.
  stopSessionRef.current = stopSession;

  const fns = {
    stopSession: () => stopSessionRef.current(),
    start_breathing_exercise: async (args: unknown) => {
      const a = (args ?? {}) as { duration_seconds?: number };
      const duration = Math.min(Math.max(Number(a.duration_seconds) || 60, 20), 300);
      setActiveExercise({ type: 'breathing', durationSeconds: duration });
      return { shown: true };
    },
    start_grounding_exercise: async () => {
      setActiveExercise({ type: 'grounding' });
      return { shown: true };
    },
    start_body_scan: async (args: unknown) => {
      const a = (args ?? {}) as { duration_seconds?: number };
      const duration = Math.min(Math.max(Number(a.duration_seconds) || 120, 30), 300);
      setActiveExercise({ type: 'body_scan', durationSeconds: duration });
      return { shown: true };
    },
    start_values_sort: async () => {
      setToolUI({ kind: 'values_sort' });
      return { shown: true };
    },
    start_fear_ladder: async () => {
      setToolUI({ kind: 'fear_ladder' });
      return { shown: true };
    },
    show_resource_card: async (args: unknown) => {
      const a = (args ?? {}) as { resource_type?: string };
      setToolUI({ kind: 'resource', resourceType: a.resource_type ?? 'all' });
      return { shown: true };
    },
    start_thought_record: async () => {
      setToolUI({ kind: 'thought_record' });
      return { shown: true };
    },
    show_journaling_prompt: async (args: unknown) => {
      const a = (args ?? {}) as { prompt?: string };
      setToolUI({ kind: 'journal', prompt: a.prompt || 'What would you like to put into words right now?' });
      return { shown: true };
    },
    create_custom_worksheet: async (args: unknown) => {
      // Renders directly from the model's function-call args (same pattern as
      // the other overlay tools). The server tool handler independently
      // validates the same args against the vetted template's structure and
      // persists the instance for researcher review — see toolRegistry.service.ts.
      const a = (args ?? {}) as {
        title?: string; intro?: string;
        sections?: Array<{ type: 'text' | 'textarea' | 'scale'; label: string; placeholder?: string }>;
      };
      if (!a.title || !Array.isArray(a.sections) || a.sections.length === 0) {
        return { shown: false };
      }
      setToolUI({
        kind: 'custom_worksheet',
        title: a.title,
        intro: a.intro ?? null,
        sections: a.sections,
      });
      return { shown: true };
    },
    display_session_recap: async (args: unknown) => {
      const a = (args ?? {}) as { focus?: string; techniques?: string[]; takeaway?: string };
      const recap = { focus: a.focus || 'Today’s conversation', techniques: a.techniques, takeaway: a.takeaway || '' };
      setToolUI({ kind: 'recap', ...recap });
      setSessionRecap(recap); // kept for "Download my work" (ai-therapist-76)
      return { shown: true };
    },
    create_safety_plan: async (args: unknown) => {
      const plan = (args ?? {}) as SafetyPlanData;
      setToolUI({ kind: 'safety_plan', plan });
      setSessionSafetyPlan(plan); // kept for "Download my work" (ai-therapist-76)
      return { shown: true };
    },
    administer_scale: async (args: unknown) => {
      const a = (args ?? {}) as { scale?: string };
      if (a.scale) setToolUI({ kind: 'scale', scale: a.scale });
      return { shown: Boolean(a.scale) };
    },
    end_session: async () => {
      // Give the model's goodbye audio a moment to finish before teardown.
      // Via the latest-ref: the direct call here used the session-start
      // render's stale closure (sessionId=null) and never POSTed /end.
      setTimeout(() => void stopSessionRef.current(), 6000);
      return { ending: true };
    },
  };

  // NOTE: the realtime session config (model, voice, instructions, tools,
  // transcription, modalities) is applied server-side when /token mints the
  // OpenAI client secret — see routes/public/token.routes.ts. The client does
  // not send its own session.update at start.

  if (!isClient) {
    // Render a placeholder or nothing on the server
    return null;
  }

  return (
    <div className="flex flex-col h-dvh bg-gray-50">
      <DemoSwitcher context="bot" />
      {/* Persistent recording indicator - unobtrusive, always visible while a
          recorded session is active (ai-therapist-24). */}
      {isSessionActive && features.session_recording_enabled === true && (
        <div
          className="fixed top-2 right-2 z-50 flex items-center gap-1.5 bg-black/70 text-white text-xs font-medium px-2.5 py-1 rounded-full pointer-events-none"
          role="status"
          aria-label="This session is being recorded"
        >
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
          Recording
        </div>
      )}
      <Header sessionId={sessionId} timeRemaining={timeRemaining} />
      <main className="flex-1 flex flex-col items-center overflow-hidden">
        {/* Themed voice indicator (voice sessions only) */}
        {isSessionActive && sessionType === 'realtime' && (
          <VoiceOrb localStream={localStream} remoteStream={remoteStream} />
        )}
        <div className="w-full flex-1 overflow-y-auto p-2 sm:p-4">
          {isSessionActive ? (
            <ChatLog messages={messages} assistantStream={assistantStream} />
          ) : postSessionData ? (
            <PostSessionScreen
              data={postSessionData}
              onDismiss={() => setPostSessionData(null)}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-center px-4">
              <div className="w-full max-w-2xl">
                <p className="text-gray-500 text-xl">
                  Press "Start Session" to begin your conversation with the AI Therapist.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="w-full max-w-4xl p-2 sm:p-4">
          {/* Persistent wrap-up notice (ai-therapist-101/112): the transient
              toast was easy to miss; this stays visible until teardown. */}
          {isSessionActive && micLocked && (
            <div
              className="mb-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm text-center px-3 py-2"
              role="status"
            >
              Wrapping up your session... the AI is saying goodbye, and the session will close in a moment.
            </div>
          )}
          <SessionControls
            startSession={() => {
              if (consentAccepted) {
                setIsCheckInOpen(true);
              } else {
                setIsConsentOpen(true);
              }
            }}
            stopSession={stopSession}
            sendTextMessage={sendTextMessage}
            isSessionActive={isSessionActive}
            localStream={localStream}
            onOpenSettings={() => setIsSettingsOpen(true)}
            chatEnabled={features.chat_enabled !== false}
            sessionType={sessionType}
            micLocked={micLocked}
            isConnecting={isConnecting}
            rateLimited={rateLimitInfo.limited}
            rateLimitResetsAt={rateLimitInfo.resetsAt}
          />
        </div>
      </main>

      {/* Guided exercise overlay (launched by AI tool calls). Completion or
          early dismissal is reported so the live model knows when to check in
          instead of guessing from the clock (ai-therapist-112). */}
      <ExerciseOverlay
        exercise={activeExercise}
        onFinish={(status) => {
          const ex = activeExercise;
          setActiveExercise(null);
          if (!ex) return;
          const label = ex.type === 'breathing' ? 'breathing exercise'
            : ex.type === 'body_scan' ? 'body scan'
            : 'grounding exercise';
          void reportToolEvent(
            status === 'completed' ? 'exercise_completed' : 'exercise_dismissed',
            status === 'completed'
              ? `[The participant's ${label} just finished. Check in gently in one short question — ask how they feel now.]`
              : `[The participant closed the ${label} early. Don't push — acknowledge gently and ask what they'd prefer to do instead.]`
          );
        }}
      />

      {/* Wave-2 tool surfaces: resource card, thought record, journal, recap, safety plan, screeners */}
      <ToolOverlays
        ui={toolUI}
        onClose={() => setToolUI(null)}
        onShareText={(text) => {
          sendTextMessage(text);
          // Only journal uses onShareText; keep it for "Download my work" (ai-therapist-76).
          if (toolUI?.kind === 'journal') {
            setSessionWriteups(prev => [...prev, { type: 'journal', label: 'Something I wrote', summary: text }]);
          }
        }}
        onInvisibleMessage={(text) => {
          // Chat sessions have no data channel — report server-side so the
          // text rides the next chat turn instead (ai-therapist-118).
          if (sessionType === 'chat') void reportToolEvent('scale_result', text);
          else sendInvisiblePrompt(text);
        }}
        onToolEvent={(kind, summary) => void reportToolEvent(kind, summary)}
        onLogRecord={(type, message, extras) => {
          logConversation({ sessionId, role: 'user', type, message, extras });
          // Kept for "Download my work" (ai-therapist-76) — participant-entered
          // content only, formatted from the same extras the model receives.
          if (type === 'thought_record') {
            const r = extras as { situation?: string; thought?: string; feeling?: string; balanced_thought?: string };
            setSessionWriteups(prev => [...prev, {
              type: 'thought_record',
              label: 'Thought record',
              summary: [
                r.situation && `Situation: ${r.situation}`,
                r.thought && `Automatic thought: ${r.thought}`,
                r.feeling && `Feeling: ${r.feeling}`,
                r.balanced_thought && `Balanced thought: ${r.balanced_thought}`,
              ].filter(Boolean).join('\n'),
            }]);
          } else if (type === 'values_sort') {
            const v = extras as { values?: string[] };
            setSessionWriteups(prev => [...prev, { type: 'values_sort', label: 'Values that matter to me', summary: (v.values ?? []).join(', ') }]);
          } else if (type === 'fear_ladder') {
            const f = extras as { items?: { situation: string; rating: number }[] };
            setSessionWriteups(prev => [...prev, {
              type: 'fear_ladder',
              label: 'My fear ladder (easiest to hardest)',
              summary: (f.items ?? []).map((it, i) => `${i + 1}. ${it.situation} (${it.rating}/10)`).join('\n'),
            }]);
          }
        }}
        sessionId={sessionId}
      />

      {/* Consent screen (IRB requirement) - must accept before check-in/session start */}
      <ConsentScreen
        isOpen={isConsentOpen}
        recordingEnabled={features.session_recording_enabled === true}
        consentVersion={consentVersion}
        body={consentBody}
        reconsentRequired={reconsentRequired}
        onCancel={() => setIsConsentOpen(false)}
        onAccept={() => {
          setConsentAccepted(true);
          setReconsentRequired(false);
          setIsConsentOpen(false);
          setIsCheckInOpen(true);
        }}
      />

      {/* Pre-session check-in (optional, skippable) */}
      <PreSessionCheckIn
        isOpen={isCheckInOpen}
        onCancel={() => setIsCheckInOpen(false)}
        onStart={(checkin) => {
          setIsCheckInOpen(false);
          void startSession(checkin);
        }}
      />

      {/* Settings Modal */}
      <SessionSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={sessionSettings}
        onSettingsChange={setSessionSettings}
        disabled={isSessionActive}
      />

      {/* Toast Notifications */}
      <ToastContainer />
      <BugReport />
    </div>

  );
}