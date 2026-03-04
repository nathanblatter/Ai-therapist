import { io } from 'socket.io-client';
import { toast } from '../../shared/components/Toast';

export function useRealtimeSession({
  sessionId, setSessionId,
  setSessionType,
  setIsSessionActive,
  setEvents, setMessages,
  setAssistantStream, setLocalStream,
  assistantBuffer,
  dataChannelRef, peerConnection, audioElement,
  socketRef,
  setSessionEndTime, setTimeRemaining,
  sessionSettings,
  logConversation, startPeriodicFlush, stopPeriodicFlush, flushLogs,
  features
}) {

  function sendClientEvent(message) {
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();
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

  function sendInvisiblePrompt(text, logMessage = null) {
    console.log('[sendInvisiblePrompt] Sending text:', text);
    console.log('[sendInvisiblePrompt] Text length:', text.length);

    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    };

    console.log('[sendInvisiblePrompt] Event:', JSON.stringify(event, null, 2));
    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
    if (logMessage !== null) {
      logConversation({ sessionId, role: "system", type: "system", message: logMessage });
    }
  }

  function getPreambleForLanguage(language, includeVoiceInstructions = true) {
    const crisisText = features._crisisContact?.enabled
      ? `call the ${features._crisisContact.hotline} crisis line at ${features._crisisContact.phone}${features._crisisContact.text ? ' or text ' + features._crisisContact.text : ''}`
      : 'call 911 or your local emergency services';

    const voiceNote = includeVoiceInstructions
      ? ` Also, please note that your microphone is off by default. If you'd like to talk using voice, you'll need to press the red mic toggle button to turn it on.`
      : '';

    return `Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. Please remember, if you're in crisis, you should ${crisisText}.${voiceNote} Thanks again for being willing to talk, I'm glad you're here with me today.`;
  }

  function getInitialPromptForLanguage(language) {
    const basePrompt = getPreambleForLanguage(language, true);

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

  async function startSession() {
    const tokenResponse = await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

    if (tokenResponse.status === 429) {
      const errorData = await tokenResponse.json();
      toast.error(errorData.message || "You have reached your session limit. Please try again later.");
      console.warn("Rate limit exceeded:", errorData);
      return;
    }

    const data = await tokenResponse.json();
    console.log("Session token data:", data);

    if (data.session?.exists) {
      toast.warning(data.message || "You already have an active session. Please end it before starting a new one.");
      console.warn("Active session already exists:", data.session.id);
      return;
    }

    const EPHEMERAL_KEY = data.value;
    const newSessionId = data.session.id;
    setSessionId(newSessionId);
    setSessionType('realtime');

    if (data.session_limits && data.session_limits.max_duration_minutes) {
      const durationMs = data.session_limits.max_duration_minutes * 60 * 1000;
      const endTime = Date.now() + durationMs;
      setSessionEndTime(endTime);
      setTimeRemaining(durationMs);
      console.log(`Session will end in ${data.session_limits.max_duration_minutes} minutes`);
    }

    // Connect to Socket.io
    const socket = io({ transports: ['websocket', 'polling'], reconnection: true });

    socket.on('connect', () => {
      console.log('Socket.io connected for session monitoring');
      socket.emit('session:join', { sessionId: newSessionId });
    });

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

    // Crisis intervention messages
    socket.on('messages:new', (data) => {
      console.log('[Crisis] Received messages:new event:', data);
      const messages = Array.isArray(data) ? data : [data];

      messages.forEach(msg => {
        if (msg.message_type === 'ai_guidance' && msg.metadata?.hidden_from_user) {
          console.log('[Crisis] Sending AI guidance to OpenAI');
          sendInvisiblePrompt(msg.content);
        } else if (msg.message_type === 'crisis_intervention' || msg.message_type === 'crisis_emergency' || msg.message_type === 'admin_visible') {
          console.log('[Crisis] Sending intervention message to AI to speak:', msg.content.substring(0, 100));
          const escapedContent = msg.content.replace(/'/g, "\\'");
          const promptToSpeak = `Say this phrase exactly: '${escapedContent}'`;

          const trySendMessage = (attempt = 0) => {
            const maxAttempts = 10;
            if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
              sendInvisiblePrompt(promptToSpeak);
            } else if (attempt < maxAttempts) {
              setTimeout(() => trySendMessage(attempt + 1), 500);
            } else {
              console.error('[Crisis] Failed to send message after max retries');
            }
          };

          trySendMessage();

          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "system", text: msg.content }
          ]);
        }
      });
    });

    // Admin messages
    socket.on('admin:message', (data) => {
      console.log('Received admin message:', data);
      const { message, messageType, senderName } = data;

      if (messageType === 'visible') {
        const fullMessage = `[Message from ${senderName}]: ${message}`;
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "system", text: fullMessage, isAdminMessage: true }
        ]);
      } else if (messageType === 'invisible') {
        if (dataChannelRef.current) {
          const event = {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: message }],
            },
          };
          dataChannelRef.current.send(JSON.stringify(event));
          dataChannelRef.current.send(JSON.stringify({ type: "response.create" }));

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

    const fns = { stopSession: () => stopSession() };

    const trimmedData = {
      ...data.session,
      instructions: "[[ OMITTED FOR LOGGING ]]",
    };

    logConversation({ sessionId: trimmedData.id, role: "system", type: "session_start", message: "Session started" });
    logConversation({ sessionId: trimmedData.id, role: "system", type: "system", message: "Session settings", extras: trimmedData });

    // Create peer connection
    const pc = new RTCPeerConnection();
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    setLocalStream(ms);
    pc.addTrack(ms.getTracks()[0]);

    const dc = pc.createDataChannel("oai-events");
    dataChannelRef.current = dc;

    dc.addEventListener("message", async (e) => {
      const event = JSON.parse(e.data);
      console.log(event);
      if (!event.timestamp) {
        event.timestamp = new Date().toLocaleTimeString();
      }

      if (event.type === 'response.function_call_arguments.done') {
        const fn = fns[event.name];
        if (fn !== undefined) {
          const args = JSON.parse(event.arguments);
          const result = await fn(args);
          logConversation({ sessionId: newSessionId, role: "system", type: "function_call", message: `Function ${event.name} called`, extra: { args, result } });
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
              sessionId: newSessionId, role: "assistant", type: "response", message: assistantMessage,
            });
          }
        }
      }

      if (event.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = event.transcript;
        if (transcript) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "user", text: transcript.trim() }
          ]);
          logConversation({ sessionId: newSessionId, role: "user", type: "voice", message: transcript.trim() });
        }
      }
      setEvents((prev) => [event, ...prev]);
    });

    dc.addEventListener("open", () => {
      console.log('[DataChannel] Channel opened');
      setIsSessionActive(true);
      setEvents([]);
      setMessages([]);
      setAssistantStream("");
      startPeriodicFlush();

      const initialPrompt = getInitialPromptForLanguage(sessionSettings.language);
      sendInvisiblePrompt(initialPrompt, `Initial prompt: ${initialPrompt}`);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const modelResponse = await fetch("/api/config/ai-model");
    const modelData = await modelResponse.json();
    const model = modelData.model || "gpt-realtime-mini";

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
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
    logConversation({ sessionId, role: "system", type: "session_end", message: "Session ended" });
    stopPeriodicFlush();
    await flushLogs();

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

    if (socketRef.current) {
      if (sessionId) {
        socketRef.current.emit('session:leave', { sessionId });
      }
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    if (dataChannelRef.current) {
      dataChannelRef.current.close();
    }

    if (peerConnection.current) {
      peerConnection.current.getSenders().forEach((sender) => {
        if (sender.track) sender.track.stop();
      });
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    dataChannelRef.current = null;
    setLocalStream(null);
    setSessionId(null);
    setSessionType(null);
    setSessionEndTime(null);
    setTimeRemaining(null);
    peerConnection.current = null;
  }

  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    };

    sendClientEvent(event);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: message },
    ]);
    sendClientEvent({ type: "response.create" });
    logConversation({ sessionId, role: "user", type: "chat", message });
  }

  return {
    startSession,
    stopSession,
    sendTextMessage,
    sendInvisiblePrompt,
    getPreambleForLanguage,
    getInitialPromptForLanguage
  };
}
