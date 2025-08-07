import { useEffect, useRef, useState } from "react";
import ChatLog from "./ChatLog";
import SessionControls from "./SessionControls";
import Header from './header';

export default function App() {
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

  async function logConversation({ sessionId, role, type, message, extras }) {
    const payload = {
      timestamp: new Date().toISOString(),
      sessionId,
      role,
      type,
      message,
      extras: extras || null,
    };
  
    try {
      await fetch("/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error("Failed to log conversation:", error);
    }
  }

  async function startSession() {
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    console.log("Session token data:", data);
    const EPHEMERAL_KEY = data.client_secret.value;
    setSessionId(data.id);

    const trimmedData = {
      ...data,
      instructions: "[[ OMITTED FOR LOGGING ]]",
      client_secret: "[[ OMITTED FOR LOGGING ]]",
      tools: "Stop Session function caller"
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

    const pc = new RTCPeerConnection();
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    setLocalStream(ms);
    pc.addTrack(ms.getTracks()[0]);

    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
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

  function stopSession() {
    logConversation({ sessionId:sessionId, role: "system", type: "session_end", message: "Session ended" });
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    setDataChannel(null);
    setLocalStream(null);
    peerConnection.current = null;
  }

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

  const fns = {
    stopSession: () => stopSession(),
  };

  useEffect(() => {
    if (dataChannel) {
      dataChannel.addEventListener("message", async (e) => {
        const event = JSON.parse(e.data);
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
        sendInvisiblePrompt("Say this phrase exactly: 'Hello! I'm an AI mental health support assistant here to listen and provide encouragement and coping ideas. I am not a licensed therapist or doctor, so I can't diagnose conditions or provide medical advice. Please remember, if you're in crisis, you should call the BYU Counseling and Psychological Services crisis line at (801) 422-3035. Also, please note that your microphone is off by default. If you'd like to talk using voice, you'll need to press the red mic toggle button to turn it on. And if you're comfortable, may I ask for your name?'");
      });
    }
  }, [dataChannel]);

  return (
    <div className="flex flex-col h-dvh bg-gray-50">
      <Header sessionId={sessionId} />
      <main className="flex-1 flex flex-col items-center overflow-hidden">
        <div className="w-full flex-1 overflow-y-auto p-2 sm:p-4">
          {isSessionActive ? (
            <ChatLog messages={messages} assistantStream={assistantStream} />
          ) : (
            <div className="flex items-center justify-center h-full text-center px-4">
              <p className="text-gray-500 text-xl">
                Press "Start Session" to begin your conversation with the AI Therapist.
              </p>
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
          />
        </div>
      </main>
    </div>
  );
}