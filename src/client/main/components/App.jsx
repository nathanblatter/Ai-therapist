import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import ChatLog from "./ChatLog";
import SessionControls from "./SessionControls";
import SessionSettings from "./SessionSettings";
import Header from './Header';

export default function App() {
  const [isClient, setIsClient] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [messages, setMessages] = useState([]);
  const [assistantStream, setAssistantStream] = useState("");
  const [localStream, setLocalStream] = useState(null);
  const assistantBuffer = useRef("");
  const userBuffer = useRef("");
  const currentVoiceMessageId = useRef(null);
  const [dataChannel, setDataChannel] = useState(null);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const [sessionSettings, setSessionSettings] = useState({
    voice: 'cedar',
    language: 'en'
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const socketRef = useRef(null);
  const [crisisContact, setCrisisContact] = useState({
    hotline: 'BYU Counseling and Psychological Services',
    phone: '(801) 422-3035',
    text: 'HELLO to 741741',
    enabled: true
  });
  const [features, setFeatures] = useState({
    output_modalities: ["audio"]
  });
  const [sessionEndTime, setSessionEndTime] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(null);
  const timerIntervalRef = useRef(null);

  useEffect(() => {
    setIsClient(true);

    // Fetch crisis contact info
    fetch('/api/config/crisis')
      .then(res => res.json())
      .then(data => setCrisisContact(data))
      .catch(err => console.error('Failed to fetch crisis contact:', err));

    // Fetch features config
    fetch('/api/config/features')
      .then(res => res.json())
      .then(data => setFeatures(data))
      .catch(err => console.error('Failed to fetch features config:', err));
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
        // Time's up! End the session
        setTimeRemaining(0);
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;

        alert("Your session time has ended. The session will now close.");
        stopSession();
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
  }, [sessionEndTime, isSessionActive]);

  // ---- Batched logger ----
  const logBufferRef = useRef([]);
  const flushInFlightRef = useRef(false);
  const flushTimerRef = useRef(null);
  const FLUSH_SIZE = 200;
  const FLUSH_INTERVAL_MS = 15000;

  function logConversation({ sessionId, role, type, message, extras }) {
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

  async function startSession() {
    // Get a session token for OpenAI Realtime API with user's settings
    const tokenResponse = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice: sessionSettings.voice,
        language: sessionSettings.language
      })
    });

    // Check for rate limiting errors
    if (tokenResponse.status === 429) {
      const errorData = await tokenResponse.json();
      alert(errorData.message || "You have reached your session limit. Please try again later.");
      console.warn("Rate limit exceeded:", errorData);
      return;
    }

    const data = await tokenResponse.json();
    console.log("Session token data:", data);

    // Check if session already exists (idempotency check)
    if (data.session?.exists) {
      alert(data.message || "You already have an active session. Please end it before starting a new one.");
      console.warn("Active session already exists:", data.session.id);
      return; // Don't proceed with session creation
    }

    const EPHEMERAL_KEY = data.value;
    const newSessionId = data.session.id;
    setSessionId(newSessionId);

    // Set up session timer if duration limit exists
    if (data.session_limits && data.session_limits.max_duration_minutes) {
      const durationMs = data.session_limits.max_duration_minutes * 60 * 1000;
      const endTime = Date.now() + durationMs;
      setSessionEndTime(endTime);
      setTimeRemaining(durationMs);
      console.log(`Session will end in ${data.session_limits.max_duration_minutes} minutes`);
    }

    // Connect to Socket.io for remote session management
    const socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true
    });

    socket.on('connect', () => {
      console.log('Socket.io connected for session monitoring');
      // Join the session-specific room to receive events for this session
      socket.emit('session:join', { sessionId: newSessionId });
    });

    // Listen for remote session termination by admin or system
    socket.on('session:status', (data) => {
      console.log('Received session:status event:', data);
      if (data.status === 'ended' && data.remoteTermination) {
        if (data.endedBy === 'system' && data.reason === 'duration_limit') {
          alert(data.message || 'Your session has ended due to time limit.');
        } else {
          alert(`Your session has been remotely ended by ${data.endedBy}. The session will now close.`);
        }
        stopSession();
      }
    });

    // Listen for admin messages during active session
    socket.on('admin:message', (data) => {
      console.log('Received admin message:', data);
      const { message, messageType, senderName } = data;

      if (messageType === 'visible') {
        // Display message directly to user
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            text: `[Message from ${senderName}]: ${message}`,
            isAdminMessage: true
          }
        ]);
      } else if (messageType === 'invisible') {
        // Send as invisible prompt to AI (guides AI response without user seeing it)
        if (dataChannel) {
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
          dataChannel.send(JSON.stringify(event));
          dataChannel.send(JSON.stringify({ type: "response.create" }));

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
    // Create a peer connection
    const pc = new RTCPeerConnection();
    // Set up to play remote audio from the model
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);
    // Add local audio track for microphone input in the browser
    const ms = await navigator.mediaDevices.getUserMedia({ audio: true,}); //video: true// });
    setLocalStream(ms);
    pc.addTrack(ms.getTracks()[0]);
    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);
    // Start the session using the Session Description Protocol (SDP)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
    const model = "gpt-realtime-mini";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
    method: "POST",
    body: offer.sdp,
    headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
    },
});

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  async function stopSession() {
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

    if (dataChannel) {
      dataChannel.close();
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
    setDataChannel(null);
    setLocalStream(null);
    setSessionId(null);
    setSessionEndTime(null);
    setTimeRemaining(null);
    peerConnection.current = null;
  }

  // flush on page unload
  useEffect(() => {
    const handler = () => {
      navigator.sendBeacon?.("/logs/batch", JSON.stringify({ records: logBufferRef.current })) || void flushLogs();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);


  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();
      dataChannel.send(JSON.stringify(message));
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error("Failed to send message - no data channel available", message);
    }
  }

  function sendTextMessage(message) {
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

  function sendInvisiblePrompt(text) {
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

    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
    logConversation({ sessionId:sessionId, role: "system", type: "system", message: `Initial prompt: ${text}` });
  }

  function getInitialPromptForLanguage(language) {
    const crisisText = crisisContact.enabled
      ? `call the ${crisisContact.hotline} crisis line at ${crisisContact.phone}${crisisContact.text ? ' or text ' + crisisContact.text : ''}`
      : 'call 911 or your local emergency services';

    const basePrompt = `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. Please remember, if you're in crisis, you should ${crisisText}. Also, please note that your microphone is off by default. If you'd like to talk using voice, you'll need to press the red mic toggle button to turn it on. Thanks again for being willing to talk, I'm glad you're here with me today.`;

    const languageNames = {
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

  const fns = {
    stopSession: () => stopSession(),
  };

  const event = {
  type: "session.update",
  session: {
      type: "realtime",
      model: "gpt-realtime",
      // Output modalities from system config (can be ["audio"], ["text"], or ["audio", "text"])
      output_modalities: features.output_modalities || ["audio"],
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: 24000,
            transcription:{
              model: "whisper-1",
            }
          },
          turn_detection: {
            type: "semantic_vad"
          }
        },
        output: {
          format: {
            type: "audio/pcm",
          },
          voice: "marin",
        }
      },
      // Use a server-stored prompt by ID. Optionally pin a version and pass variables.
      prompt: {
        id: "pmpt_123",          // your stored prompt ID
        version: "89",           // optional: pin a specific version
        variables: {
          city: "Paris"          // example variable used by your prompt
        }
      },
      // You can still set direct session fields; these override prompt fields if they overlap:
      instructions: "Speak clearly and briefly. Confirm understanding before taking actions."
  },
};

  useEffect(() => {
    if (dataChannel) {
      dataChannel.addEventListener("message", async (e) => {
        const event = JSON.parse(e.data);
        console.log(event)
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }

        if (event.type === 'response.function_call_arguments.done') {
          const fn = fns[event.name];
          if (fn !== undefined) {
            const args = JSON.parse(event.arguments);
            const result = await fn(args);
            logConversation({ sessionId:sessionId, role: "system", type: "function_call", message: `Function ${event.name} called`, extra: { args, result } });
          }
        }

        if (event.type && event.type.startsWith("response")) {
          if (event.response && event.response.output) {
            event.response.output.forEach((out) => {
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
                sessionId:sessionId,
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
            logConversation({ sessionId:sessionId, role: "user", type: "voice", message: transcript.trim() });
          }
        }
        setEvents((prev) => [event, ...prev]);
      });

      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        setMessages([]);
        setAssistantStream("");
        startPeriodicFlush();

        sendInvisiblePrompt(getInitialPromptForLanguage(sessionSettings.language));
      });
    }
  }, [dataChannel, sessionSettings.language]);

  if (!isClient) {
    // Render a placeholder or nothing on the server
    return null;
  }

  return (
    <div className="flex flex-col h-dvh bg-gray-50">
      <Header sessionId={sessionId} timeRemaining={timeRemaining} />
      <main className="flex-1 flex flex-col items-center overflow-hidden">
        <div className="w-full flex-1 overflow-y-auto p-2 sm:p-4">
          {isSessionActive ? (
            <ChatLog messages={messages} assistantStream={assistantStream} />
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
          <SessionControls
            startSession={startSession}
            stopSession={stopSession}
            sendTextMessage={sendTextMessage}
            isSessionActive={isSessionActive}
            localStream={localStream}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        </div>
      </main>

      {/* Settings Modal */}
      <SessionSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={sessionSettings}
        onSettingsChange={setSessionSettings}
        disabled={isSessionActive}
      />
    </div>

  );
}