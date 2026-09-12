import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Loader } from 'react-feather';
import ChatLog from "./ChatLog";
import SessionControls from "./SessionControls";
import SessionSettings from "./SessionSettings";
import PreSessionCheckIn, { type CheckinData } from "./PreSessionCheckIn";
import ConsentScreen from "./ConsentScreen";
import QuietHoursScreen from "./QuietHoursScreen";
import StudyStatusScreen from "./StudyStatusScreen";
import ExerciseOverlay, { type ActiveExercise } from "./ExerciseOverlay";
import ToolOverlays, { type ToolUI, type SafetyPlanData } from "./ToolOverlays";
import PostSessionScreen, { type PostSessionData, type SessionRecapData, type SharedWriteup } from "./PostSessionScreen";
import ModerationRecoveryScreen, { type ModerationRecoveryStage } from "./ModerationRecoveryScreen";
import Header from './Header';
import Home from './Home';
import Messages from './Messages';
import VoiceOrb from './VoiceOrb';
import { initializeLogger } from '../utils/logger';
import ToastContainer, { toast } from '../../shared/components/Toast';
import BugReport from './BugReport';
import DemoSwitcher from '../../shared/components/DemoSwitcher';
import { startMixedTee, type AudioTeeHandle } from '../lib/audioTee';
import { createAudioUploader, type AudioUploader } from '../lib/audioUploader';
import { createParticipantSocket } from '../lib/participantSocket';
import { getUserSocket, closeUserSocket } from '../lib/userSocket';
import { useMessagingUnread } from '../hooks/useMessaging';
import { getStoredTheme, setTheme } from '../../shared/theme';
import { reportClientEvent } from '../utils/telemetry';
import {
  configureEngagementTelemetry,
  installEngagementTracking,
  recordEngagementEvent,
  recordTurnTiming,
  setEngagementSessionId,
} from '../utils/engagementTelemetry';
import type { ChatMessage } from './ChatLog';
// Canonical crisis-contact blob shape is shared with the server (src/shared).
import type { CrisisContact } from '../../../shared/systemConfig';

interface Features {
  output_modalities: string[];
  voice_enabled: boolean;
  chat_enabled: boolean;
  session_recording_enabled?: boolean;
  telemetry_interaction_timing?: boolean;
  telemetry_engagement_events?: boolean;
}

interface SessionSettings {
  voice: string;
  language: string;
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

/** Shape every GPT-Live data-channel event shares. Fields are read per case. */
interface LiveServerEvent {
  type?: string;
  [key: string]: unknown;
}

// GPT-Live caps `session.*.append` content at 500 tokens. We clamp on
// characters rather than risk the API rejecting the event outright: dropping a
// crisis steer because it ran three words long is not an acceptable failure
// mode. Mirrors truncateForAppend in sidebandManager.service.ts.
const MAX_APPEND_CHARS = 1600; // ~500 tokens at a pessimistic 3.2 chars/token

function truncateForAppend(content: string): string {
  if (content.length <= MAX_APPEND_CHARS) return content;
  console.warn(`[Live] Append content truncated from ${content.length} to ${MAX_APPEND_CHARS} chars.`);
  return content.slice(0, MAX_APPEND_CHARS);
}

/** How long to wait for `session.closed` after asking the session to finish. */
const LIVE_CLOSE_TIMEOUT_MS = 15_000;
/** How long to wait for `session.started` after the SDP answer is applied. */
const LIVE_START_TIMEOUT_MS = 20_000;
/** How long a delegation may run before the "thinking" hint gives up on itself. */
const LIVE_THINKING_TIMEOUT_MS = 20_000;
/**
 * Voice sessions we will start to recover from a content-filter termination
 * (incident 2026-09-11) before falling back to text.
 *
 * Two, not more: the recovery session carries no history and runs a narrow
 * crisis-support prompt, so a filter termination on it is far less likely — but
 * if it happens twice anyway, the platform is refusing this conversation in
 * voice and retrying a third time would just keep hanging up on the participant.
 */
const MAX_VOICE_RECOVERY_ATTEMPTS = 2;
/**
 * How long the recovery flow waits for `session.started` before declaring the
 * attempt dead. Deliberately longer than LIVE_START_TIMEOUT_MS so the start
 * path's own failsafe tears the half-open call down first — the recovery flow
 * never has to run a competing teardown.
 */
const RECOVERY_START_WAIT_MS = LIVE_START_TIMEOUT_MS + 3_000;

/**
 * Resolve once the peer connection has gathered all of its ICE candidates.
 *
 * GPT-Live takes the offer through a single HTTP request, so there is no
 * trickle-ICE path for candidates discovered after we send it — an offer posted
 * early just connects with fewer candidates. The timeout is a deliberate
 * compromise: a network that never reaches 'complete' (a stalled STUN server is
 * the usual cause) should still get a session rather than hang on Start.
 */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(() => {
      console.warn('[Live] ICE gathering did not complete in time; sending the offer as gathered.');
      finish();
    }, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onStateChange);
  });
}

/**
 * One caption row on screen.
 *
 * GPT-Live transcript deltas carry no item id and no turn-completed event, so
 * row identity is ours to invent and then keep stable — the captions guide is
 * explicit that deriving it from the (changing) text or from end timestamps
 * breaks as rows grow. `startMs`/`endMs` are positions on the session timeline,
 * not wall-clock times, and are used only for grouping.
 */
interface CaptionRow {
  id: string;
  startMs: number;
  endMs: number;
}

// Fragments from the same speaker within this distance of a row's interval join
// that row. It is an application choice, not a protocol value: a display group
// is not a semantic turn, and both speakers can be mid-row at the same time.
const CAPTION_GAP_MS = 2000;

export default function App() {
  const [isClient, setIsClient] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState<unknown[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantStream, setAssistantStream] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  // Always-on capture: tee mixes mic+assistant audio; uploader POSTs it to the
  // server (HTTP, since the participant socket is unreliable through the tunnel).
  const audioTeeRef = useRef<AudioTeeHandle | null>(null);
  const audioUploaderRef = useRef<AudioUploader | null>(null);
  const participantUploaderRef = useRef<AudioUploader | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Latest-ref for stopSession (ai-therapist-113): the WebRTC data-channel
  // handler is attached once inside startRealtimeSession, closing over THAT
  // render's stopSession — in which sessionId state is still null. Calling it
  // directly made model-initiated end_session silently skip the POST /end
  // (and the session_end log, and the post-session snapshot). Handlers must
  // go through this ref so they always get the current-render closure.
  const stopSessionRef = useRef<() => Promise<void>>(async () => {});
  // A session the server has created for a start attempt that hasn't finished
  // connecting yet. If the start path then fails client-side (mic permission,
  // SDP exchange), the catch in startSession uses this to release the server
  // session — otherwise it lingers as "active" and blocks every retry until
  // the duration limit expires.
  const pendingStartSessionRef = useRef<{ id: string; kind: 'realtime' | 'chat' } | null>(null);
  // ---- GPT-Live session state --------------------------------------------
  // All of these are refs rather than state because the data-channel handler is
  // attached once, during startRealtimeSession, and would otherwise read the
  // start-render's values forever (the ai-therapist-113 stale-closure family).
  //
  // liveSessionId  — the id the SERVER returned; authoritative before the
  //                  sessionId state update has landed.
  // liveStarted    — `session.started` seen. Nothing may be sent before this.
  // liveFinalized  — `session.closed` seen. Only this confirms finalization and
  //                  final usage; a transport close on its own does not.
  const liveSessionIdRef = useRef<string | null>(null);
  const liveStartedRef = useRef(false);
  const liveFinalizedRef = useRef(false);
  const liveClosedWaiterRef = useRef<(() => void) | null>(null);
  const liveStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTearingDownRef = useRef(false);
  // Tool calls arrive on the data channel AND on the server's sideband. Ours is
  // UI-only, but a redelivered envelope must not re-open an overlay.
  const handledToolCallsRef = useRef<Set<string>>(new Set());
  const captionRowsRef = useRef<{ user: CaptionRow[]; assistant: CaptionRow[] }>({ user: [], assistant: [] });
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
    text: 'HOME to 741741',
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
  // GPT-Live hands substantive work to a delegated backend and tells us when it
  // starts (session.delegation.created). Surfacing that keeps a few seconds of
  // "why is nothing happening" from reading as a broken session. The timer is a
  // failsafe: delegated work that never produces speech must not pin the hint on
  // screen for the rest of the session.
  const [isBackendThinking, setIsBackendThinking] = useState(false);
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionType, setSessionType] = useState<string | null>(null); // 'realtime' or 'chat'

  // ---- Content-filter takeover (incident 2026-09-11) ----------------------
  // OpenAI's own safety filter can terminate a GPT-Live session outright
  // (`session.closed` with reason 'content'), and it does so disproportionately
  // at the exact moment a participant discloses suicidal intent — which is what
  // happened on 2026-09-11: the assistant had started the right response and the
  // platform cut the call mid-sentence, dropping the participant onto the
  // generic post-session screen. We hung up on someone in crisis.
  //
  // The recovery is to bring the VOICE agent straight back and keep it talking.
  // POST /api/live/session with `recovery: true` starts a session on a narrow
  // crisis-support prompt (short warm replies, repeatedly encourage 988, ask who
  // could be with them, 911 if in immediate danger, never go silent) running in
  // client delegation mode so there are no backend pauses — and carrying NO
  // prior history, because replaying the disclosure that tripped the filter is
  // the most likely way to trip it again. Text is now the LAST resort, only
  // after the voice attempts are spent. See handleModerationTermination below.
  const [moderationRecovery, setModerationRecovery] = useState<ModerationRecoveryStage | null>(null);
  // Both `session.closed` (data channel, fast) and `session:moderation-terminated`
  // (socket backstop) can announce the same termination; only the first wins.
  // Reset on every live start, recovery sessions included, so a second
  // termination is not swallowed by the first one's guard.
  const moderationHandledRef = useRef(false);
  // True from the moment the takeover starts until the participant is talking
  // again (voice or text). stopSession() reads it so the voice teardown still
  // runs in full but does NOT raise the post-session screen underneath the
  // recovery screen — and so a failed recovery start does not either.
  const moderationTakeoverRef = useRef(false);
  // The ORIGINAL filter-terminated voice session: the only one that holds the
  // conversation, so it is what the text continuation is seeded from and what
  // the manual retry reuses. Recovery sessions never overwrite it.
  const moderationVoiceSessionIdRef = useRef<string | null>(null);
  // Voice recovery attempts spent on the current crisis. Capped at
  // MAX_VOICE_RECOVERY_ATTEMPTS; reset only by a genuinely new (non-recovery)
  // voice session, so a filter that kills the recovery too cannot loop forever.
  const moderationVoiceAttemptsRef = useRef(0);
  // Whether the CURRENTLY RUNNING voice session is a crisis recovery. Reactive
  // (not a ref) because it drives SessionControls' startMicOn: a recovery
  // session must come back with the mic already live. The normal default is
  // mic OFF and the opening preamble tells the participant to press the mic
  // button — but recovery deliberately skips that preamble, so a muted
  // recovery means the assistant speaks, the participant answers out loud, and
  // nothing is heard. The session built to never go silent would go silent,
  // and no turn would reach the crisis pipeline.
  const [isRecoverySession, setIsRecoverySession] = useState(false);
  // Set while stopSession()'s voice teardown is actually in flight. isTearingDown
  // stays true after it finishes (it exists to reject late session.closed events),
  // so it cannot answer "has the old call finished dying yet?" — which is exactly
  // what the recovery start has to wait for to avoid two peer connections and two
  // mic captures overlapping.
  const voiceTeardownInFlightRef = useRef(false);
  // Latest-ref (ai-therapist-113 family): the data-channel handler is attached
  // once at session start, so it must not close over that render's handler.
  const moderationHandlerRef = useRef<(terminatedSessionId: string | null) => Promise<void>>(async () => {});

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
  // Quiet hours (ai-therapist-152): when the server reports the overnight
  // window active for this participant, a blocking screen with crisis
  // resources replaces session start. Re-polled so it lifts at 6:00 AM
  // without a manual refresh.
  const [quietHours, setQuietHours] = useState<{ blocksYou: boolean; startHour: number; endHour: number } | null>(null);
  // Withdrawn/paused study status (server-enforced 403 study_status on
  // session start; see middleware/studyStatus.ts). Rendered as a blocking
  // screen with crisis resources — never a generic error toast.
  const [studyStatusBlock, setStudyStatusBlock] = useState<'paused' | 'withdrawn' | 'access_blocked' | null>(null);

  // Async secure messaging (caseworker portal): between-sessions view switch
  // + persistent user socket for logged-in participants. The socket is
  // latency sugar only; useMessaging HTTP-polls regardless.
  const [activeView, setActiveView] = useState<'home' | 'messages'>('home');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const messagesUnread = useMessagingUnread(isAuthenticated);

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => setIsAuthenticated(Boolean(data?.authenticated)))
      .catch(() => { /* stay anonymous */ });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    getUserSocket();
    return () => closeUserSocket();
  }, [isAuthenticated]);

  // Phase 2 engagement telemetry (flag-gated, default off). Reply timing is
  // measured from the last assistant message rendered to the next user send;
  // events are scoped to the active session and flushed when it ends.
  const lastAssistantAtRef = useRef<number | null>(null);
  const prevToolUIKindRef = useRef<string | null>(null);

  useEffect(() => {
    setEngagementSessionId(isSessionActive ? sessionId : null);
  }, [isSessionActive, sessionId]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') lastAssistantAtRef.current = performance.now();
  }, [messages]);

  useEffect(() => {
    const kind = toolUI?.kind ?? null;
    const prev = prevToolUIKindRef.current;
    prevToolUIKindRef.current = kind;
    if (kind && kind !== prev) recordEngagementEvent('tool_open', { tool: kind });
    else if (!kind && prev) recordEngagementEvent('tool_close', { tool: prev });
  }, [toolUI]);

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
    installEngagementTracking();

    // Fetch crisis contact info
    fetch('/api/config/crisis')
      .then(res => res.json())
      .then(data => setCrisisContact(data))
      .catch(err => console.error('Failed to fetch crisis contact:', err));

    // Quiet hours: pre-check on load, then every 5 minutes so the overnight
    // screen appears/lifts on its own at the window boundaries.
    const fetchQuietHours = () =>
      fetch('/api/config/quiet-hours', { credentials: 'include' })
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) setQuietHours(data); })
        .catch(err => console.error('Failed to fetch quiet hours status:', err));
    fetchQuietHours();
    const quietHoursTimer = setInterval(fetchQuietHours, 5 * 60_000);

    // Fetch daily-session rate-limit status so a capped participant sees the
    // limit up front instead of after consent + check-in (429 on session start).
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
      .then(data => {
        setFeatures(data);
        // Phase 2 telemetry gates (default off; server enforces regardless).
        configureEngagementTelemetry({
          interactionTiming: data.telemetry_interaction_timing === true,
          engagementEvents: data.telemetry_engagement_events === true,
        });
      })
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

    return () => clearInterval(quietHoursTimer);
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

  /**
   * Fold one GPT-Live transcript fragment into this speaker's captions.
   *
   * The rules here come straight from the captions guide and each one is load
   * bearing:
   *  - the delta is concatenated EXACTLY as received (no trim, no inserted
   *    space) — the fragments already carry their own spacing;
   *  - a fragment is not a turn, and the model is full duplex, so the user and
   *    assistant rows are grown independently and can both be open at once;
   *  - rows keep the id they were created with and are never reordered, so a
   *    growing row does not jump to the bottom of an overlapping exchange;
   *  - the newest-first scan (rather than "always the last row") is what lets a
   *    late fragment land back in the earlier row it belongs to.
   */
  function appendTranscriptDelta(role: 'user' | 'assistant', delta: string, startMs: number, endMs: number) {
    if (!delta) return;
    const rows = captionRowsRef.current[role];
    let row: CaptionRow | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const candidate = rows[i];
      if (startMs - candidate.endMs <= CAPTION_GAP_MS && candidate.startMs - endMs <= CAPTION_GAP_MS) {
        row = candidate;
        break;
      }
    }

    if (row) {
      row.startMs = Math.min(row.startMs, startMs);
      row.endMs = Math.max(row.endMs, endMs);
      const rowId = row.id;
      setMessages(prev => prev.map(m => (m.id === rowId ? { ...m, text: m.text + delta } : m)));
      return;
    }

    const created: CaptionRow = { id: crypto.randomUUID(), startMs, endMs };
    rows.push(created);
    setMessages(prev => [...prev, { id: created.id, role, text: delta }]);
  }

  /** Show the delegated-work hint, with a failsafe so it always clears. */
  function markBackendThinking(thinking: boolean) {
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
    setIsBackendThinking(thinking);
    if (thinking) {
      thinkingTimeoutRef.current = setTimeout(() => setIsBackendThinking(false), LIVE_THINKING_TIMEOUT_MS);
    }
  }

  // Wrapper function that routes to realtime or chat-only based on features.
  // Any failure on the start path (mic permission, session request, SDP
  // exchange) lands here: show a specific toast and always re-enable the Start
  // button instead of failing silently (ai-therapist-117).
  async function startSession(checkin: CheckinData | null = null) {
    setPostSessionData(null); // clear the previous session's post-session screen
    setModerationRecovery(null); // and any leftover content-filter recovery screen
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
      cleanupFailedStart();
    }
  }

  /**
   * Best-effort teardown of whatever a failed start left behind (socket, data
   * channel, peer connection, mic track, server-side session) so the next
   * attempt is clean.
   *
   * Shared with the content-filter voice recovery (incident 2026-09-11), which
   * bypasses startSession entirely: a half-started recovery attempt must not
   * leave a second peer connection or a second mic capture alive behind the
   * crisis screen. It deliberately touches no moderation state — the takeover is
   * still in progress when this runs on that path.
   */
  function cleanupFailedStart() {
    setIsConnecting(false);
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
    // Release the server-side session this failed attempt created, so the
    // participant can retry immediately instead of hitting "active session
    // already exists" until the duration limit expires.
    const orphan = pendingStartSessionRef.current;
    if (orphan) {
      pendingStartSessionRef.current = null;
      const endUrl = orphan.kind === 'chat' ? '/api/chat/end' : `/api/sessions/${orphan.id}/end`;
      void fetch(endUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .catch((endErr) => console.error('Failed to release orphaned session:', endErr));
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

      // Quiet hours (server-enforced): swap to the overnight screen. This
      // branch is terminal for ANY 403 — the body is consumed here, so
      // falling through to the response.json() below would double-read it.
      if (response.status === 403) {
        const errorData = await response.json().catch(() => null);
        if (errorData?.error === 'quiet_hours') {
          setQuietHours({ blocksYou: true, ...errorData.quietHours });
          setIsConnecting(false);
          return;
        }
        if (errorData?.error === 'study_status') {
          setStudyStatusBlock(errorData.studyStatus === 'paused' ? 'paused' : 'withdrawn');
          setIsConnecting(false);
          return;
        }
        if (errorData?.error === 'identifier_blocked') {
          setStudyStatusBlock('access_blocked');
          setIsConnecting(false);
          return;
        }
        throw new Error(errorData?.message || 'Chat session start was forbidden (403)');
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
      pendingStartSessionRef.current = { id: newSessionId, kind: 'chat' };

      // Connect to Socket.io for remote session management
      socketRef.current = connectChatSocket(newSessionId);

      // Add preamble message to chat (similar to realtime voice therapy)
      setMessages([{
        id: crypto.randomUUID(),
        role: "assistant",
        text: getPreambleForLanguage(sessionSettings.language, false),
      }]);

      console.log(`Chat-only session started: ${newSessionId}`);
      pendingStartSessionRef.current = null; // start succeeded — nothing to release

    } catch (error) {
      console.error('Failed to start chat session:', error);
      toast.error('Failed to start chat session. Please try again.');
      reportClientEvent('chat_send_failed', { where: 'start', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      if (pendingStartSessionRef.current?.kind === 'chat') {
        pendingStartSessionRef.current = null;
        void fetch('/api/chat/end', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
          .catch((endErr) => console.error('Failed to release orphaned chat session:', endErr));
      }
    }
  }

  // Socket wiring shared by every chat session — the ordinary one started above
  // and the crisis continuation below — so a handler can never exist on one path
  // and be missing from the other.
  function connectChatSocket(chatSessionId: string): Socket {
    const socket = createParticipantSocket(chatSessionId, 'chat');

    socket.on('session:status', (data) => {
      console.log('Received session:status event:', data);
      if (data.status === 'ended' && data.remoteTermination) {
        toast.warning(`Your session has been remotely ended by ${data.endedBy}. The session will now close.`);
        // Via the latest-ref (ai-therapist-113 pattern): this handler closes
        // over the render where sessionId/sessionType state were still null,
        // so a direct stopSession() would take the wrong teardown path and
        // skip the post-session snapshot.
        void stopSessionRef.current();
      }
    });

    // Deterministic crisis-resource surfacing: a high-severity flag must not
    // depend on the model choosing to include resources in its reply — the
    // server's crisis-emergency event opens the resource card directly.
    socket.on('session:crisis-emergency', () => {
      setToolUI({ kind: 'resource', resourceType: 'all' });
    });

    return socket;
  }

  /**
   * Move a voice conversation that the content filter killed into text.
   *
   * POST /api/chat/start with `continued_from` seeds the new session with the
   * last turns of the voice conversation plus an instruction to pick up exactly
   * where it stopped — so the participant never has to repeat a disclosure they
   * just made. Failure is NOT allowed to fall through to the generic end screen:
   * the recovery screen stays up with crisis resources and a retry button.
   *
   * This is the LAST resort. The first move is always to bring the voice agent
   * back (startRecoveryVoiceSession below); we only end up here once those
   * attempts are spent.
   */
  async function continueInChat(voiceSessionId: string | null) {
    setModerationRecovery('text');
    try {
      const response = await fetch('/api/chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: sessionSettings.language, continued_from: voiceSessionId }),
      });
      if (!response.ok) {
        throw new Error(`Chat continuation start failed with status ${response.status}`);
      }
      const data = await response.json();
      // `alreadyActive` means the server still has the voice session (or another
      // one) open, so this is not a session we can safely talk in — treat it as
      // a failure and let the retry run once the /end has landed.
      if (data.alreadyActive || !data.sessionId) {
        throw new Error(data.alreadyActive ? 'Chat continuation blocked by an active session' : 'Chat continuation returned no session id');
      }

      const newSessionId = data.sessionId as string;
      setSessionId(newSessionId);
      setSessionType('chat');
      setSessionEndTime(null);
      setTimeRemaining(null);
      setIsSessionActive(true);
      socketRef.current = connectChatSocket(newSessionId);

      // The voice captions are deliberately left on screen: this is the same
      // conversation continuing, not a new one. One system line explains the
      // switch; everything else the participant hears comes from the model,
      // which the server has already told to resume where it stopped.
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: "We got cut off by an automated filter — not by anything you said. I'm still here. Let's keep going right here, in writing.",
        },
      ]);

      moderationTakeoverRef.current = false;
      setModerationRecovery(null);
      console.log(`[Live] Voice session continued as chat session ${newSessionId}`);
    } catch (error) {
      console.error('[Live] Failed to continue a filter-terminated session in chat:', error);
      reportClientEvent('chat_send_failed', {
        where: 'moderation_continuation',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }, voiceSessionId);
      setModerationRecovery('failed');
    }
  }

  /**
   * Bring the voice agent straight back after a content-filter termination.
   *
   * `recovery: true` is the whole request: the server swaps in the narrow
   * crisis-support prompt, runs the session in client delegation mode so the
   * model answers with no backend pause, and deliberately carries NO prior
   * conversation history. The client must not put that history back — no seeded
   * input, no replaying captions into the new session — because re-stating the
   * disclosure that tripped the filter is the most reliable way to trip it
   * again. The participant's own voice and language carry over; nothing else.
   *
   * Resolves true only once `session.started` has actually landed, i.e. the
   * agent is live and about to speak. Anything short of that is a failed attempt
   * and the caller moves on to the next fallback.
   */
  async function startRecoveryVoiceSession(): Promise<boolean> {
    moderationVoiceAttemptsRef.current += 1;
    const attempt = moderationVoiceAttemptsRef.current;
    setModerationRecovery('voice');
    console.warn(`[Live] Starting voice recovery attempt ${attempt}/${MAX_VOICE_RECOVERY_ATTEMPTS}.`);

    try {
      await startRealtimeSession(null, true);
      // startRealtimeSession returns as soon as the SDP answer is applied; the
      // session is only genuinely usable at `session.started`.
      const started = await waitForLiveStart(RECOVERY_START_WAIT_MS);
      if (!started) {
        throw new Error('Recovery voice session never reported session.started');
      }

      // Live again: drop the interstitial and hand the screen back to the normal
      // voice UI. The agent re-greets on its own (see the speak-first nudge in
      // the `session.started` branch), so there is no silence to explain.
      moderationTakeoverRef.current = false;
      setModerationRecovery(null);
      console.log(`[Live] Voice recovery attempt ${attempt} is live as session ${String(liveSessionIdRef.current)}.`);
      return true;
    } catch (error) {
      console.error(`[Live] Voice recovery attempt ${attempt} failed:`, error);
      reportClientEvent('webrtc_failed', {
        stage: 'moderation_voice_recovery',
        attempt,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }, moderationVoiceSessionIdRef.current);
      // Whatever the failed start left behind (peer connection, mic track,
      // socket, server-side session) is released here, so the next attempt — or
      // the text fallback — starts from a clean slate.
      cleanupFailedStart();
      return false;
    }
  }

  /** Poll for `session.started`; the flag is a ref, so there is nothing to await on. */
  async function waitForLiveStart(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (liveStartedRef.current) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return liveStartedRef.current;
  }

  /** Wait out an in-flight voice teardown so the recovery start cannot race it. */
  async function waitForVoiceTeardown(timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (voiceTeardownInFlightRef.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (voiceTeardownInFlightRef.current) {
      console.warn('[Live] Voice teardown did not finish in time; starting recovery anyway.');
    }
  }

  /**
   * OpenAI's content filter ended this voice session (incident 2026-09-11 — a
   * participant said "I wanna kill myself", the assistant began the right
   * response, and the platform cut the call mid-sentence, leaving them on the
   * generic post-session screen).
   *
   * The teardown of the terminated session still runs in full underneath (peer
   * connection, mic tracks, audio uploaders, POST /end, session_end log) — what
   * changes is what the participant SEES and where the conversation goes:
   *
   *   1. the recovery screen, immediately, with 988 / the text line / 911 on it;
   *   2. a NEW voice session on the crisis-support prompt, started automatically,
   *      and they are back in the normal voice UI still talking;
   *   3. if the filter kills that one too, one more voice attempt;
   *   4. only then the text continuation;
   *   5. and if even that fails, the crisis screen stays up with a manual retry.
   *
   * Never the generic post-session screen. That is the failure this fixes.
   */
  async function handleModerationTermination(terminatedSessionId: string | null) {
    if (moderationHandledRef.current) return; // data channel and socket both announce it
    // A late announcement about a session we have already moved on from (the
    // socket backstop can arrive after the recovery session is up) must not tear
    // down the conversation the participant is currently having.
    if (terminatedSessionId && liveSessionIdRef.current && terminatedSessionId !== liveSessionIdRef.current) {
      console.warn('[Live] Ignoring a moderation termination for a session that is no longer live.');
      return;
    }
    moderationHandledRef.current = true;

    const voiceSessionId = terminatedSessionId ?? liveSessionIdRef.current ?? sessionId;
    // First one wins: only the original session holds the conversation, so it is
    // what the text continuation would be seeded from. Recovery sessions have no
    // history to continue.
    moderationVoiceSessionIdRef.current ??= voiceSessionId;
    console.error('[Live] Session terminated by the content filter; taking over with the recovery screen.');
    reportClientEvent('data_channel_error', {
      stage: 'moderation_terminated',
      voiceRecoveryAttemptsSpent: moderationVoiceAttemptsRef.current,
    }, voiceSessionId);

    // Screen first: the participant must not see the post-session screen for a
    // single frame, so this happens before any awaited teardown work.
    moderationTakeoverRef.current = true;
    setPostSessionData(null);
    setModerationRecovery('voice');

    if (isTearingDownRef.current) {
      // A stopSession() is already in flight (it asked for this close, or the
      // server ended the session first). Running teardown twice would fight it;
      // wait for it to finish instead — both so its POST /end lands before we
      // ask for a new session, and so its peer connection and mic capture are
      // really gone before the recovery start opens new ones.
      await waitForVoiceTeardown();
    } else {
      try {
        await stopSessionRef.current();
      } catch (error) {
        console.error('[Live] Teardown failed during the content-filter takeover:', error);
      }
    }

    // Voice first, and again if the filter takes the recovery session too.
    if (features.voice_enabled !== false && moderationVoiceAttemptsRef.current < MAX_VOICE_RECOVERY_ATTEMPTS) {
      if (await startRecoveryVoiceSession()) return;
    }

    // Voice is spent. A failed voice attempt may have tripped the start path's
    // own failsafe teardown, which is still landing its POST /end — wait it out,
    // or /api/chat/start would reject the continuation as "active session
    // already exists" and strand the participant on the failure screen.
    await waitForVoiceTeardown();

    // Text is the last resort — and if this deployment has no text modality
    // there is nowhere left to go, so stay on the screen with the resources
    // rather than dumping them onto the end screen.
    if (features.chat_enabled === false) {
      setModerationRecovery('unavailable');
      return;
    }

    await continueInChat(moderationVoiceSessionIdRef.current ?? voiceSessionId);
  }

  // Voice therapy session over GPT-Live: WebRTC media tracks for audio, an
  // `oai-events` data channel for JSON events.
  //
  // The handshake is inverted relative to the Realtime API this replaces. We no
  // longer mint an ephemeral key and POST the SDP to api.openai.com from the
  // browser; the offer goes to OUR server, which creates the session with the
  // project key and returns the SDP answer and the session id in the JSON body.
  // Two consequences worth remembering:
  //  - no OpenAI credential ever reaches the browser;
  //  - the `Location`-header scraping that used to hand the server a call_id is
  //    gone entirely, and with it the whole class of failure it caused. That
  //    header was invisible whenever CORS did not expose it, which meant no
  //    sideband, no live monitoring and no crisis steering — silently, until we
  //    added a beacon for it (ai-therapist-195). The server now knows the
  //    session id before the browser does and attaches its own sideband, so
  //    there is nothing left to register.
  /**
   * @param recovery Start this session on the server's crisis-support prompt to
   *   recover from a content-filter termination (incident 2026-09-11). It is a
   *   fresh session with no history by design, so the ordinary opening preamble
   *   and the caption reset are skipped and the moderation takeover state is
   *   left alone — the takeover is still in progress while this runs.
   */
  async function startRealtimeSession(checkin: CheckinData | null = null, recovery = false) {
    // Drives SessionControls.startMicOn. A recovery session resumes a
    // conversation the participant was already speaking in, so it must come
    // back with the microphone live rather than muted behind a preamble it
    // never hears.
    setIsRecoverySession(recovery);
    // Reset per-session Live state before anything can dispatch into it.
    liveSessionIdRef.current = null;
    liveStartedRef.current = false;
    liveFinalizedRef.current = false;
    liveClosedWaiterRef.current = null;
    // The previous session's teardown left this true so that its own late
    // `session.closed` could not start anything; this is a real new session, and
    // leaving it set would make its data-channel and socket handlers treat every
    // event as arriving during a teardown.
    isTearingDownRef.current = false;
    handledToolCallsRef.current = new Set();
    // Always: caption rows are grouped by position on the SESSION timeline,
    // which restarts at zero here. Carrying rows across would let the first
    // words of the recovery session merge into the last row of the terminated
    // one. The visible messages are a separate list and do survive (below).
    captionRowsRef.current = { user: [], assistant: [] };
    // Per-session — recovery sessions included — or a second filter termination
    // would be swallowed by the first one's dedupe guard and the participant
    // would land on the post-session screen after all.
    moderationHandledRef.current = false;
    if (!recovery) {
      // A genuinely new conversation: the crisis that spent these is over.
      moderationTakeoverRef.current = false;
      moderationVoiceSessionIdRef.current = null;
      moderationVoiceAttemptsRef.current = 0;
    }

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
        reportClientEvent('webrtc_failed', { stage: 'connectionstatechange' }, liveSessionIdRef.current);
        void stopSessionRef.current();
      } else if (state === 'disconnected') {
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            disconnectTimerRef.current = null;
            const s = pc.connectionState;
            if (s === 'disconnected' || s === 'failed') {
              toast.error('The connection to your session was lost. The session has ended — you can start a new one whenever you are ready.');
              reportClientEvent('webrtc_disconnected', { stage: 'grace-period-expired', state: s }, liveSessionIdRef.current);
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

    // Microphone first: the SDP offer has to carry the audio track. Asking
    // before the server call also means a denied-permission start never creates
    // a session — and GPT-Live bills 15 seconds of voice duration at session
    // initialization, so an abandoned session costs real money.
    //
    // Enable the browser's built-in mic DSP so steady background noise (fans,
    // hum, room tone) is suppressed before audio ever reaches the model.
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    setLocalStream(ms);
    pc.addTrack(ms.getTracks()[0], ms);

    // The data channel and every one of its listeners must exist BEFORE
    // createOffer(): the channel is negotiated in the SDP, and `session.started`
    // can arrive the moment the answer is applied.
    const dc = pc.createDataChannel("oai-events");
    dataChannelRef.current = dc;

    dc.addEventListener("error", (e) => {
      console.error('[DataChannel] error:', e);
      reportClientEvent('data_channel_error', { stage: 'oai-events' }, liveSessionIdRef.current);
    });

    dc.addEventListener("close", () => {
      // A transport close is not finalization. If it happens before
      // `session.closed`, the final usage for this session is unconfirmed —
      // worth reporting, because our own teardown closes the channel only after
      // that event (or after giving up on it).
      if (!liveFinalizedRef.current && !isTearingDownRef.current) {
        console.warn('[Live] Data channel closed before session.closed; final usage is unconfirmed.');
        reportClientEvent('data_channel_error', { stage: 'closed_before_finalize' }, liveSessionIdRef.current);
      }
    });

    dc.addEventListener("message", async (e) => {
      const event = JSON.parse(e.data as string) as LiveServerEvent;
      if (!event.type) return;

      switch (event.type) {
        // The session is ready. Nothing may be sent before this arrives.
        case 'session.started': {
          const startedId = (event.session as { id?: string } | undefined)?.id ?? null;
          console.log('[Live] Session started:', startedId);
          liveStartedRef.current = true;
          if (liveStartTimeoutRef.current) {
            clearTimeout(liveStartTimeoutRef.current);
            liveStartTimeoutRef.current = null;
          }
          pendingStartSessionRef.current = null; // start succeeded — nothing to release
          setIsConnecting(false);
          setIsSessionActive(true);
          setEvents([]);
          // A content-filter recovery session (incident 2026-09-11) is a new
          // session, but it is the SAME conversation to the participant: wiping
          // the captions would make it look like the last few minutes never
          // happened, at the worst possible moment. Only the in-progress
          // fragment goes.
          if (!recovery) setMessages([]);
          setAssistantStream("");
          startPeriodicFlush();

          if (recovery) {
            // The recovery session must speak first — "never go silent" is the
            // whole point of it — and GPT-Live never speaks unprompted, so it
            // still needs the documented instructions-append nudge. What it must
            // NOT get is any of the previous conversation: the server left that
            // history out deliberately, because restating the disclosure that
            // tripped the filter is the most likely way to trip it again. This
            // nudge carries timing only, no content.
            sendInvisiblePrompt(
              'The voice connection just dropped and has reconnected. Speak first, immediately, before the participant says anything: reconnect warmly in one or two sentences, make clear it was a technical drop and not their fault, and stay with them.',
              'Recovery session: speak-first nudge',
            );
            break;
          }

          // Opening preamble. Realtime got this as a hidden user turn plus a
          // forced response; GPT-Live has neither, so it is delivered the
          // documented way — a trusted instructions append that tells the model
          // to speak first instead of waiting for the participant.
          const initialPrompt = getInitialPromptForLanguage(sessionSettings.language);
          sendInvisiblePrompt(
            `${initialPrompt} Say it immediately, before the participant speaks, then pause and listen.`,
            `Initial prompt: ${initialPrompt}`,
          );
          break;
        }

        // Participant speech. There is no completion event and no item id, so
        // the caption row is grouped and owned entirely on our side.
        case 'session.input_transcript.delta':
          appendTranscriptDelta(
            'user',
            String(event.delta ?? ''),
            Number(event.start_ms ?? 0),
            Number(event.end_ms ?? 0),
          );
          break;

        // Assistant speech. Its arrival also means the delegated work (if any)
        // has produced something to say.
        case 'session.output_transcript.delta':
          markBackendThinking(false);
          appendTranscriptDelta(
            'assistant',
            String(event.delta ?? ''),
            Number(event.start_ms ?? 0),
            Number(event.end_ms ?? 0),
          );
          break;

        // Backend work started — drives the "thinking" hint only. It is not a
        // promise that the model will say anything about it.
        case 'session.delegation.created':
          markBackendThinking(true);
          break;

        // Nested Responses events arrive wrapped. The envelope's own type is
        // always 'response.event'; dispatching on it instead of the inner type
        // would silently drop every tool call.
        case 'response.event':
          await handleNestedResponseEvent(event.event as LiveServerEvent | undefined);
          break;

        // The final event. Only this confirms finalization and final usage.
        case 'session.closed': {
          const usage = event.usage as { seconds?: number } | undefined;
          console.log(`[Live] Session closed: reason=${String(event.reason)} seconds=${String(usage?.seconds)}`);
          liveFinalizedRef.current = true;
          markBackendThinking(false);
          logConversation({
            sessionId: liveSessionIdRef.current,
            role: 'system',
            type: 'system',
            message: 'Live session closed',
            extras: { reason: event.reason ?? null, usage: usage ?? null },
          });
          const waiter = liveClosedWaiterRef.current;
          if (waiter) {
            // stopSession() asked for this close and is holding the transport
            // open for it — let it finish the teardown.
            liveClosedWaiterRef.current = null;
            waiter();
          }

          // reason 'content' means OpenAI's own safety filter ended the call.
          // On 2026-09-11 that happened to a participant the moment they
          // disclosed suicidal intent, and the normal teardown below dropped
          // them onto the generic post-session screen — we hung up on someone in
          // crisis. This branch takes over instead: recovery screen with crisis
          // resources, then the same conversation continued in text.
          if (event.reason === 'content') {
            void moderationHandlerRef.current(liveSessionIdRef.current);
          } else if (!waiter && !isTearingDownRef.current) {
            // The session ended on its own (duration limit, safety filter,
            // upstream drop). Run the normal teardown through the latest-ref so
            // the POST /end, the session_end log and the post-session snapshot
            // still happen (ai-therapist-113).
            void stopSessionRef.current();
          }
          break;
        }

        // Errors are not necessarily terminal: moderation can cut off the
        // assistant's current speech and leave the session running. Read them
        // even while audio plays, and do not tear down on our own here.
        case 'error': {
          const err = event.error as { code?: string; message?: string; client_event_id?: string } | undefined;
          console.error('[Live] API error:', err);
          reportClientEvent('data_channel_error', {
            stage: 'live_error',
            code: err?.code ?? null,
            message: (err?.message ?? '').slice(0, 200),
          }, liveSessionIdRef.current);
          logConversation({
            sessionId: liveSessionIdRef.current,
            role: 'system',
            type: 'system',
            message: `Live API error: ${err?.message ?? 'unknown'}`,
            extras: err ?? null,
          });
          break;
        }

        default:
          break;
      }

      // Lifecycle events only. Transcript deltas arrive several times a second
      // and nothing reads them back, so keeping them here would be a pure leak.
      if (!event.type.endsWith('_transcript.delta')) {
        setEvents((prev) => [event, ...prev].slice(0, 200));
      }
    });

    // SDP offer, then wait for ICE gathering: the offer travels in one HTTP
    // request, so late candidates have nowhere to go.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 10_000);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) {
      const missingSdp = new Error('Missing local SDP offer');
      missingSdp.name = 'SdpFetchError';
      throw missingSdp;
    }

    // Every early return below happens with the microphone already open (the
    // offer needs the track), so each one has to hand the mic back.
    const abortStart = () => {
      dataChannelRef.current = null;
      dc.close();
      pc.onconnectionstatechange = null;
      pc.getSenders().forEach((sender) => sender.track?.stop());
      pc.close();
      peerConnection.current = null;
      setLocalStream(null);
      setIsConnecting(false);
    };

    // The offer goes to our own server, which holds the project key, runs the
    // study's gates (consent, quiet hours, study status, rate limits) and only
    // then creates the OpenAI session. The current picker values are sent
    // explicitly (request body wins server-side) so the choice also applies for
    // anonymous participants, who have no saved preferences row; logged-in
    // users' preferences remain the fallback when nothing is sent.
    const response = await fetch("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: localSdp,
        voice: sessionSettings.voice,
        language: sessionSettings.language,
        checkin,
        // Content-filter recovery (incident 2026-09-11). The server owns what
        // this means: the crisis-support prompt, client delegation mode so there
        // are no backend pauses, and no prior conversation history. The client
        // sends the flag and the participant's existing voice/language — and
        // nothing else, so there is no history for it to smuggle back in.
        ...(recovery ? { recovery: true } : {}),
      }),
    });

    // Check for rate limiting errors
    if (response.status === 429) {
      const errorData = await response.json();
      toast.error(errorData.message || "You have reached your session limit. Please try again later.");
      console.warn("Rate limit exceeded:", errorData);
      setRateLimitInfo({ limited: true, resetsAt: errorData.limit_resets_at ?? null });
      abortStart();
      return;
    }

    // Quiet hours (server-enforced): swap to the overnight screen.
    if (response.status === 403) {
      const errorData = await response.json().catch(() => null);
      if (errorData?.error === 'quiet_hours') {
        setQuietHours({ blocksYou: true, ...errorData.quietHours });
        abortStart();
        return;
      }
      if (errorData?.error === 'study_status') {
        setStudyStatusBlock(errorData.studyStatus === 'paused' ? 'paused' : 'withdrawn');
        abortStart();
        return;
      }
      // Our AI provider blocked this participant's anonymous identifier
      // (ai-therapist-186) — unrecoverable client-side, so point them at the
      // research team instead of a "check your connection" toast.
      if (errorData?.error === 'identifier_blocked') {
        setStudyStatusBlock('access_blocked');
        abortStart();
        return;
      }
    }

    // The study was rolled back to a non-Live voice backend after this page
    // loaded. Nothing the participant can fix, and not a network problem.
    if (response.status === 409) {
      const errorData = await response.json().catch(() => null);
      if (errorData?.error === 'live_not_active') {
        toast.error('Voice sessions are temporarily unavailable. Please refresh the page and try again, or contact the research team if this keeps happening.');
        console.warn('Live backend is not active:', errorData);
        abortStart();
        return;
      }
    }

    if (!response.ok) {
      // Name the error so startSession()'s catch reports it as sdp_fetch_failed
      // (rather than a generic webrtc_failed) before the network toast.
      const sdpError = new Error(`Live session request failed with status ${response.status}`);
      sdpError.name = 'SdpFetchError';
      throw sdpError;
    }

    const data = await response.json();

    // Check if session already exists (idempotency check)
    if (data.session?.exists) {
      toast.warning(data.message || "You already have an active session. Please end it before starting a new one.");
      console.warn("Active session already exists:", data.session.id);
      abortStart();
      return;
    }

    const newSessionId = data.session_id as string;
    const sdpAnswer = data.sdp as string;
    if (!newSessionId || !sdpAnswer) {
      const badResponse = new Error('Live session response is missing session_id or sdp');
      badResponse.name = 'SdpFetchError';
      throw badResponse;
    }

    liveSessionIdRef.current = newSessionId;
    setSessionId(newSessionId);
    setSessionType('realtime');
    pendingStartSessionRef.current = { id: newSessionId, kind: 'realtime' };

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
        // Via the latest-ref (ai-therapist-113): this handler was created in
        // the render where sessionId state is still null; a direct
        // stopSession() call skipped the POST /end, the session_end log and
        // the post-session snapshot.
        void stopSessionRef.current();
      }
    });

    // Age-eligibility end (ai-therapist-106): the participant disclosed being a
    // minor. The server has injected goodbye guidance to the model and will
    // force-end the session after a short grace; the client closes its own
    // end-session flow (same family as the remote-termination notice above).
    socket.on('session:eligibility-end', () => {
      toast.warning('This study is only open to adults 18 and older, so this session is ending. Take good care.');
      // Latest-ref for the same stale-closure reason as session:status above.
      void stopSessionRef.current();
    });

    // Deterministic crisis-resource surfacing: a high-severity flag must not
    // depend on the model choosing to call show_resource_card — the server's
    // crisis-emergency event opens the resource card directly.
    socket.on('session:crisis-emergency', () => {
      setToolUI({ kind: 'resource', resourceType: 'all' });
    });

    // Backstop for the content-filter takeover (incident 2026-09-11). The
    // server's sideband sees the same termination we do; `session.closed` on the
    // data channel is faster and more reliable, so this only matters when the
    // transport died with it. handleModerationTermination dedupes the two.
    socket.on('session:moderation-terminated', (data: { sessionId?: string } | undefined) => {
      console.warn('[Live] Moderation termination announced over the socket.');
      void moderationHandlerRef.current(data?.sessionId ?? null);
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
          console.log('[Crisis] Steering the live model with AI guidance');
          sendInvisiblePrompt(msg.content);
        }
        // Crisis intervention and admin messages: send to AI to speak them
        else if (msg.message_type === 'crisis_intervention' || msg.message_type === 'crisis_emergency' || msg.message_type === 'admin_visible') {
          console.log('[Crisis] Sending intervention message to AI to speak:', msg.content.substring(0, 100));
          // Escape single quotes in the message content
          const escapedContent = msg.content.replace(/'/g, "\\'");
          // Wrap in "Say this phrase exactly" format so AI speaks it. An
          // instruction requests the wording; it does not guarantee it, which is
          // why the same text is also shown in the chat log below.
          const promptToSpeak = `Say this phrase exactly: '${escapedContent}'`;

          // Retry sending if data channel isn't ready yet
          const trySendMessage = (attempt = 0) => {
            const maxAttempts = 10;
            if (dataChannelRef.current && dataChannelRef.current.readyState === 'open' && liveStartedRef.current) {
              console.log('[Crisis] Session is live, steering the model');
              sendInvisiblePrompt(promptToSpeak);
            } else if (attempt < maxAttempts) {
              const state = dataChannelRef.current ? dataChannelRef.current.readyState : 'null';
              console.log(`[Crisis] Session not ready (channel=${state}, started=${liveStartedRef.current}), retry ${attempt + 1}/${maxAttempts} in 500ms`);
              setTimeout(() => trySendMessage(attempt + 1), 500);
            } else {
              console.error('[Crisis] Failed to send message after max retries - session never became ready');
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
        // Steer the AI without the participant seeing it. Note the behaviour
        // change GPT-Live forces: Realtime inserted this as a hidden turn in the
        // participant's voice, but Live has no conversation item list, so it
        // becomes an application instruction instead of impersonation.
        sendInvisiblePrompt(message, `Admin invisible prompt: ${message}`);
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket.io disconnected');
    });

    socketRef.current = socket;

    logConversation({
      sessionId: newSessionId,
      role: "system",
      type: "session_start",
      message: "Session started",
    });
    logConversation({
      sessionId: newSessionId,
      role: "system",
      type: "system",
      message: "Session settings",
      // The clinical prompt and tool schemas live server-side now — the browser
      // never sees them, so there is nothing to omit from this record.
      extras: {
        id: newSessionId,
        backend: 'live',
        // Marks the sessions started by the content-filter recovery flow so the
        // research data can tell them apart from participant-initiated ones.
        recovery,
        voice: data.voice ?? sessionSettings.voice,
        language: data.language ?? sessionSettings.language,
        session_limits: data.session_limits ?? null,
      },
    });

    // Assistant audio arrives on a media track. Registered before the answer is
    // applied so no track event can land before we are listening.
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      setRemoteStream(e.streams[0]);
      // Capture the whole conversation: mix mic + assistant audio into one PCM
      // stream and upload it over HTTP for the entire session, so the server can
      // record it and relay it live to any admin who is listening. Independent
      // of the API change — it taps the media tracks, not the event stream.
      // Gated on the features.session_recording_enabled flag (also shown in the
      // consent screen the participant just accepted) — when it's off, capture
      // never starts and nothing is uploaded.
      if (!audioTeeRef.current && features.session_recording_enabled) {
        const uploader = createAudioUploader(newSessionId);
        audioUploaderRef.current = uploader;
        // Second, mic-only track (pre-gain tap) for prosody research — a
        // subset of the audio already captured in the mix, same consent gate.
        const participantUploader = createAudioUploader(newSessionId, 400, 'participant');
        participantUploaderRef.current = participantUploader;
        audioTeeRef.current = startMixedTee(
          [ms, e.streams[0]],
          (pcm, sampleRate) => {
            uploader.push(pcm, sampleRate);
          },
          {
            stream: ms,
            onChunk: (pcm, sampleRate) => {
              participantUploader.push(pcm, sampleRate);
            },
          },
        );
      }
    };

    // Apply the answer. The HTTP request already started the session — there is
    // deliberately no `session.start` on the data channel.
    await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });

    // If the answer applies but `session.started` never lands, the participant
    // would sit on "Connecting..." forever with a session that is already
    // billing. Fail loudly instead.
    liveStartTimeoutRef.current = setTimeout(() => {
      liveStartTimeoutRef.current = null;
      if (liveStartedRef.current) return;
      console.error('[Live] No session.started within the timeout; abandoning this connection.');
      reportClientEvent('webrtc_failed', {
        stage: 'no_session_started',
        recovery,
        connectionState: pc.connectionState,
        iceState: pc.iceConnectionState,
      }, newSessionId);
      // No toast on the recovery path: the crisis screen is already up and owns
      // the explanation, and it is about to move the participant on to the next
      // fallback — a "check your connection" toast over it would only alarm.
      if (!recovery) {
        toast.error('Could not start your session — there was a problem reaching the server. Please check your connection and try again.');
      }
      void stopSessionRef.current();
    }, LIVE_START_TIMEOUT_MS);
  }

  /**
   * Handle one nested Responses event from a `response.event` envelope.
   *
   * Only `response.output_item.done` matters to the browser: it is the one place
   * a call's name AND call_id both appear (an arguments-done event carries
   * neither). What we do with it is UI only — open the overlay the model asked
   * for. The server's sideband is watching the same session and owns the
   * canonical execution, so the browser must never send a function_call_output
   * or the backend would receive two results for one call.
   */
  async function handleNestedResponseEvent(inner: LiveServerEvent | undefined) {
    if (inner?.type !== 'response.output_item.done') return;
    const item = inner.item as
      | { type?: string; name?: string; call_id?: string; arguments?: string }
      | undefined;
    if (item?.type !== 'function_call' || !item.name || !item.call_id) return;
    if (handledToolCallsRef.current.has(item.call_id)) return;
    handledToolCallsRef.current.add(item.call_id);

    markBackendThinking(false);

    const fn = (fns as Record<string, ((args: unknown) => Promise<unknown>) | undefined>)[item.name];
    if (fn === undefined) return;

    let args: unknown = {};
    try {
      args = JSON.parse(item.arguments || '{}');
    } catch (err) {
      console.error(`[Live] Could not parse arguments for ${item.name}:`, err);
    }
    const result = await fn(args);
    logConversation({
      sessionId: liveSessionIdRef.current,
      role: "system",
      type: "function_call",
      message: `Function ${item.name} called`,
      extras: { args, result },
    });
  }

  async function stopSession() {
    setActiveExercise(null);
    setToolUI(null);
    setMicLocked(false);
    setIsConnecting(false);
    markBackendThinking(false);
    if (liveStartTimeoutRef.current) {
      clearTimeout(liveStartTimeoutRef.current);
      liveStartTimeoutRef.current = null;
    }
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
    // Suppressed during a content-filter takeover (incident 2026-09-11): the
    // teardown below still runs in full, but the participant stays on the
    // recovery screen and continues in text — the post-session screen appearing
    // underneath it is the exact "we hung up on them" experience we are fixing.
    if (sessionId && !moderationTakeoverRef.current) {
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

    // ---- Handle the GPT-Live voice session -------------------------------
    isTearingDownRef.current = true;
    // Separate from isTearingDown, which stays true afterwards so a late
    // session.closed cannot start anything. This one is cleared at the end, so
    // the content-filter recovery (incident 2026-09-11) can wait for the old
    // call to actually finish dying before opening a new peer connection and a
    // new mic capture.
    voiceTeardownInFlightRef.current = true;

    // Graceful close. Ask the session to finish, then keep the peer connection,
    // the data channel and the microphone tracks ALIVE until `session.closed`
    // arrives: that event is the only thing that confirms finalization and
    // carries the final usage seconds, and closing the transport straight after
    // sending the command is documented to prevent it from ever being
    // delivered. The `session.closed` listener is the data-channel handler
    // installed at session start, so it is registered long before this command.
    const liveChannel = dataChannelRef.current;
    if (liveChannel && liveChannel.readyState === 'open' && liveStartedRef.current && !liveFinalizedRef.current) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(closeTimer);
          liveClosedWaiterRef.current = null;
          resolve();
        };
        liveClosedWaiterRef.current = done;
        const closeTimer = setTimeout(() => {
          // Incomplete finalization: report it and release the resources rather
          // than holding a dead call open forever.
          console.warn('[Live] No session.closed within the timeout; final usage is unconfirmed.');
          reportClientEvent('data_channel_error', { stage: 'no_session_closed' }, liveSessionIdRef.current);
          done();
        }, LIVE_CLOSE_TIMEOUT_MS);
        try {
          liveChannel.send(JSON.stringify({ type: 'session.close', event_id: `close_${Date.now()}` }));
        } catch (error) {
          console.error('[Live] Failed to send session.close:', error);
          done();
        }
      });
    }

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
    if (participantUploaderRef.current) {
      participantUploaderRef.current.stop();
      participantUploaderRef.current = null;
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
    // Live state: liveSessionId and the caption rows are left for the
    // post-session screen's lifetime and reset by the next start.
    // isTearingDownRef deliberately stays true, so a session.closed that lands
    // after teardown cannot start a second one.
    liveStartedRef.current = false;
    liveClosedWaiterRef.current = null;
    // The old call is fully dead: transport closed, mic tracks stopped,
    // uploaders flushed, POST /end sent. A content-filter recovery waiting on
    // this can now safely open its own.
    voiceTeardownInFlightRef.current = false;
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


  // Send one client event on the GPT-Live data channel. Guarded on
  // `session.started` as well as the channel state: the HTTP request starts the
  // session, but commands sent before that event are not accepted.
  function sendClientEvent(message: Record<string, unknown>) {
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open' && liveStartedRef.current) {
      message.event_id = (message.event_id as string | undefined) || crypto.randomUUID();
      dataChannelRef.current.send(JSON.stringify(message));
      setEvents((prev) => [{ ...message, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 200));
    } else {
      const state = dataChannelRef.current ? dataChannelRef.current.readyState : 'null';
      console.error(`Failed to send message - session not ready (channel: ${state}, started: ${liveStartedRef.current})`, message);
    }
  }

  async function sendTextMessage(message: string) {
    // Phase 2 telemetry: typed-turn reply timing (length only, no content).
    recordTurnTiming(
      lastAssistantAtRef.current === null ? null : performance.now() - lastAssistantAtRef.current,
      message.length,
      sessionType === 'chat' ? 'chat' : 'realtime_text',
    );

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

        if (response.status === 403) {
          const errorData = await response.json().catch(() => null);
          if (errorData?.error === 'identifier_blocked') {
            setStudyStatusBlock('access_blocked');
            return;
          }
        }
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

    // Handle the GPT-Live voice session. Typed text is participant DATA, not an
    // instruction, so it is queued for the delegated backend as a user message
    // rather than appended to the live model's instructions. Queueing an item
    // does not start work on its own — response.create is what continues the
    // backend. (Both replace the Realtime conversation.item.create pair; Live
    // has no conversation item list to write into.)
    sendClientEvent({
      type: "response.item.create",
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
    });
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: message },
    ]);
    sendClientEvent({ type: "response.create" });
    // Typed turns produce no transcript deltas, so unlike spoken turns the
    // server's sideband never sees them — this log is the only record.
    logConversation({ sessionId: liveSessionIdRef.current ?? sessionId, role: "user", type: "chat", message: message });
  }

  /**
   * Steer the live model with trusted application text: the opening preamble, a
   * crisis intervention line, an admin's invisible prompt, a tool outcome.
   *
   * Realtime did this by inserting a hidden user turn and then forcing a
   * response. GPT-Live has neither — no conversation item list, and no
   * response.create that makes the VOICE model speak — so the equivalent is an
   * instructions append: it influences behaviour and speech, can interrupt
   * speech already in progress, and needs no follow-up event. `delegation_id:
   * null` scopes it to the session rather than to one piece of backend work.
   *
   * An append requests wording; it never guarantees it. Callers that must show
   * the participant the exact text (crisis interventions) also render it.
   */
  function sendInvisiblePrompt(text: string, logMessage: string | null = null) {
    console.log('[sendInvisiblePrompt] Appending instructions, length:', text.length);
    sendClientEvent({
      type: "session.instructions.append",
      delegation_id: null,
      content: truncateForAppend(text),
    });
    // Only log if a custom log message is provided (for initial prompts)
    // Crisis intervention guidance messages are already logged server-side
    if (logMessage !== null) {
      // Latest-ref, not state: this runs from data-channel and socket handlers
      // that closed over the render where sessionId was still null, which used
      // to drop the record entirely (ai-therapist-113 family).
      logConversation({ sessionId: liveSessionIdRef.current ?? sessionId, role: "system", type: "system", message: logMessage });
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
      : 'call or text 988 (Suicide and Crisis Lifeline), or call 911 for immediate danger';

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
  // Same latest-ref discipline for the content-filter takeover: it is invoked
  // from the data-channel handler and the participant socket, both of which were
  // registered in the session-start render.
  moderationHandlerRef.current = handleModerationTermination;

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

  // NOTE: the whole session config (model, voice, instructions, delegated
  // backend, tools) is applied server-side when POST /api/live/session creates
  // the GPT-Live session — see routes/public/liveSession.routes.ts. The client
  // sends no configuration of its own, and could not: GPT-Live freezes model,
  // instructions, input and audio after startup, so there is no client-side
  // session.update path to drift from the server's config.

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
      <Header
        sessionId={sessionId}
        timeRemaining={timeRemaining}
        messagesUnread={messagesUnread}
        onOpenMessages={isAuthenticated && !isSessionActive
          ? () => setActiveView(v => (v === 'messages' ? 'home' : 'messages'))
          : undefined}
        messagesOpen={activeView === 'messages'}
      />
      <main className="flex-1 flex flex-col items-center overflow-hidden">
        {/* Themed voice indicator (voice sessions only) */}
        {isSessionActive && sessionType === 'realtime' && (
          <VoiceOrb localStream={localStream} remoteStream={remoteStream} />
        )}
        <div className="w-full flex-1 overflow-y-auto p-2 sm:p-4">
          {isSessionActive ? (
            <ChatLog
              messages={messages}
              assistantStream={assistantStream}
              onScrollBack={() => recordEngagementEvent('scroll_back')}
            />
          ) : activeView === 'messages' && isAuthenticated ? (
            /* Async secure messaging (caseworker portal): not real-time —
               the component carries its own crisis-resources banner. */
            <Messages />
          ) : postSessionData ? (
            <PostSessionScreen
              data={postSessionData}
              onDismiss={() => setPostSessionData(null)}
            />
          ) : (
            /* Between-sessions Home (ai-therapist-121): progress, worksheets,
               safety plan for logged-in participants; anonymous users still get
               the plain start prompt. The Start controls below stay outside the
               scroll area, so they are always visible and never blocked. */
            <Home onOpenMessages={() => setActiveView('messages')} messagesUnread={messagesUnread} />
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
          {/* Delegated-work hint (session.delegation.created). Deliberately
              quiet: it says work started, not that the assistant is about to
              speak about it. Suppressed during wrap-up, which has its own copy. */}
          {isSessionActive && sessionType === 'realtime' && isBackendThinking && !micLocked && (
            <div className="mb-2 flex items-center justify-center gap-2 text-sm text-gray-500" role="status">
              <Loader size={14} className="animate-spin" aria-hidden="true" />
              Thinking...
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
            startMicOn={isRecoverySession}
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
        onToolEvent={(kind, summary) => {
          recordEngagementEvent('tool_event', { kind });
          void reportToolEvent(kind, summary);
        }}
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

      {/* Content-filter recovery (incident 2026-09-11). z-[70] — above every
          other overlay, including quiet hours: a participant whose session was
          cut at a crisis disclosure must see this and its resources, not the
          overnight screen and not the post-session screen. Normally up for only
          a few seconds while the voice agent comes back.

          The manual retry is text: the 'failed' stage is only reachable once the
          voice attempts are spent, and offering another would just hang up on
          them again. */}
      {moderationRecovery && (
        <ModerationRecoveryScreen
          stage={moderationRecovery}
          crisisContact={crisisContact}
          onRetry={() => { void continueInChat(moderationVoiceSessionIdRef.current); }}
        />
      )}

      {/* Quiet hours (ai-therapist-152): overnight blocking screen with crisis
          resources. z-[60] so it sits above the consent overlay (z-50).
          Suppressed while a session is active AND while the post-session
          screen is up — a session that spans 10pm must still get its
          ratings/feedback collected before the overnight screen takes over. */}
      {quietHours?.blocksYou && !isSessionActive && !postSessionData && (
        <QuietHoursScreen startHour={quietHours.startHour} endHour={quietHours.endHour} />
      )}
      {/* paused/withdrawn are start-time gates, so they defer to an in-flight
          session; access_blocked can surface MID-session (the provider
          rejects the very next turn), and leaving the participant staring at
          a dead conversation would be worse than interrupting it. */}
      {studyStatusBlock && (studyStatusBlock === 'access_blocked' || (!isSessionActive && !postSessionData)) && (
        <StudyStatusScreen status={studyStatusBlock} />
      )}

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
        onCancel={() => {
          recordEngagementEvent('checkin_dismissed');
          setIsCheckInOpen(false);
        }}
        onStart={(checkin) => {
          recordEngagementEvent(checkin ? 'checkin_complete' : 'checkin_skip');
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