import { useState, useRef, useEffect } from "react";
import { CloudOff, MessageSquare, Mic, CloudLightning, MicOff } from "react-feather";
import Button from "./Button"; 

function SessionStopped({ startSession }) {
  const [isActivating, setIsActivating] = useState(false);

  function handleStartSession() {
    if (isActivating) return;
    setIsActivating(true);
    startSession();
  }

  return (
    <div className="flex items-center justify-center w-full h-full">
      <button
        className="p-3 bg-byuRoyal hover:bg-green-700 text-white rounded-full"
        onClick={handleStartSession}
        title="start session"
        disabled={isActivating}
      >
        Start Session
      </button>
    </div>
  );
}

function SessionActive({ stopSession, sendTextMessage, localStream }) {
  const [message, setMessage] = useState("");
  const [isMicOn, setIsMicOn] = useState(true); //assuming mic is on by default
  const streamRef = useRef(null);

  // keep reference to the current microphone stream
  useEffect(() => {
    streamRef.current = localStream;
    if (localStream) {
      const track = localStream.getAudioTracks()[0];
      if (track) {
        setIsMicOn(track.enabled);
      }
    }
  }, [localStream]);

  function handleSendClientEvent() {
    sendTextMessage(message);
    setMessage("");
  }

  const toggleMic = () => {
    const stream = streamRef.current;
    if (!stream) return;
  
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
  
    audioTrack.enabled = !audioTrack.enabled;
    setIsMicOn(audioTrack.enabled);
  };
  return (
    <div className="flex items-center gap-2 w-full h-full">
      <button
        className="p-3 bg-byuRoyal hover:bg-red-700 text-white rounded-full"
        onClick={stopSession}
        title="disconnect"
      >
        Disconnect
      </button>

      <input
        onKeyDown={(e) => {
          if (e.key === "Enter" && message.trim()) {
            handleSendClientEvent();
          }
        }}
        type="text"
        placeholder="Type a message..."
        className="border border-gray-200 rounded-full p-3 flex-1"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <button
        className="p-3 bg-byuRoyal hover:bg-gray-700 text-white rounded-full"
        onClick={() => {
          if (message.trim()) {
            handleSendClientEvent();
          }
        }}
        title="send"
      >
        Send Message
      </button>

      <button
      onClick={toggleMic}
      className={`p-3 rounded-full ${isMicOn ? "bg-red-600" : "bg-green-600"} text-white`}
      title={isMicOn ? "Mic Off" : "Mic On"}
    >
      {isMicOn ? <MicOff size={18} /> : <Mic size={18} />}
    </button>
    </div>
  );
}

export default function SessionControls({
  startSession,
  stopSession,
  sendTextMessage,
  isSessionActive,
  localStream,
}) {
  return (
    <div className="flex gap-4 border-t-2 border-gray-200 h-full rounded-md">
      {isSessionActive ? (
        <SessionActive
          stopSession={stopSession}
          sendTextMessage={sendTextMessage}
          localStream={localStream}
        />
      ) : (
        <SessionStopped startSession={startSession} />
      )}
    </div>
  );
}
