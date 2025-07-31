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

  async function logConversation(message) {
    try {
      await fetch("/log", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });
    } catch (error) {
      console.error("Failed to log conversation:", error);
    }
  }

  async function startSession() {
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.client_secret.value;
    setSessionId(data.id); // <-- store the session ID
    console.log(data);


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
    logConversation(`User: ${message}`);
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
    logConversation(`INVISIBLE USER PROMPT: ${text}`);
  }

  useEffect(() => {
    if (dataChannel) {
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
          
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
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  text: assistantMessage,
                },
              ]);
              assistantBuffer.current = "";
              setAssistantStream("");
              logConversation(
                `
               
                Assistant: ${assistantMessage}
                `);
            }
          }
        }

        if (event.type && event.type.startsWith("transcript")) {
          if (event.transcript && event.transcript.text) {
            if (!currentVoiceMessageId.current) {
              const id = crypto.randomUUID();
              currentVoiceMessageId.current = id;
              setMessages((prev) => [
                ...prev,
                { id, role: "user", text: "" },
              ]);
            }
            userBuffer.current += event.transcript.text;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentVoiceMessageId.current
                  ? { ...m, text: userBuffer.current.trim() }
                  : m
              )
            );
          }

          if (event.type === "transcript.done" && userBuffer.current) {
            const userMessage = userBuffer.current.trim();
            currentVoiceMessageId.current = null;
            userBuffer.current = "";
            sendClientEvent({ type: "response.create" });
            logConversation(`User: ${userMessage}`);
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
            logConversation(`User: ${transcript.trim()}`);
          }
        }
        setEvents((prev) => [event, ...prev]);
      });

      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        setMessages([]);
        setAssistantStream("");

        // ✅ Invisible trigger for intro message
        sendInvisiblePrompt("Say this phrase exactly: 'Test123 this still works'");
      });
    }
  }, [dataChannel]);

  return (
    <div className="flex flex-col h-dvh bg-gray-50">
      <Header sessionId={sessionId} />
      
      <main className="flex-1 flex flex-col items-center overflow-hidden">
        <div className="w-full flex-1 overflow-y-auto p-2 sm:p-4">
          {isSessionActive ? ( 
            <ChatLog
              messages={messages}
              assistantStream={assistantStream}
            />
            
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