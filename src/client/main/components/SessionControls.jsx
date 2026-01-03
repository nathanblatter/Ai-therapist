import { useState, useRef, useEffect } from "react";
import { Mic, MicOff, PhoneOff, Send, Play, Settings } from "react-feather";

function SessionStopped({ startSession, onOpenSettings }) {
  const [isActivating, setIsActivating] = useState(false);

  function handleStartSession() {
    if (isActivating) return;
    setIsActivating(true);
    startSession();
  }

  return (
    <div className="flex items-center justify-center w-full h-full gap-3">
      <button
        className="p-3 bg-byuRoyal hover:bg-green-700 text-white rounded-full font-semibold px-4 py-3 flex items-center justify-center gap-2"
        onClick={handleStartSession}
        title="Start Session"
        disabled={isActivating}
      >
        <span className="">Start Session</span>
      </button>
      <button
        className="p-3 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-full flex items-center justify-center"
        onClick={onOpenSettings}
        title="Settings"
      >
        <Settings size={20} />
      </button>
    </div>
  );
}

function SessionActive({ stopSession, sendTextMessage, localStream }) {
  const [message, setMessage] = useState("");
  const [isMicOn, setIsMicOn] = useState(true);
  const streamRef = useRef(null);

  useEffect(() => {
    streamRef.current = localStream;
    if (localStream) {
      const track = localStream.getAudioTracks()[0];
      if (track) {
        track.enabled = false; // turn mic OFF by default
        setIsMicOn(false);
      }
    }
  }, [localStream]);

  function handleSendTextMessage() {
    if (message.trim()) {
      sendTextMessage(message);
      setMessage("");
    }
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
        className="p-3 sm:px-4 sm:py-2 bg-byuRoyal hover:bg-red-600 text-white rounded-full flex items-center justify-center"
        onClick={stopSession}
        title="Disconnect"
      >
        {/* Icon is visible only on small screens */}
        <span className="sm:hidden">
          <PhoneOff size={18} />
        </span>
        {/* Text is hidden on small screens and visible on larger screens */}
        <span className="hidden sm:inline">Disconnect Session</span>
      </button>

      <button
        onClick={toggleMic}
        className={`p-3 rounded-full ${
          isMicOn ? "bg-green-600 " : "bg-red-600"
        } text-white`}
        title={isMicOn ? "Mute" : "Unmute"}
      >
        {isMicOn ? <Mic size={18} /> : <MicOff size={18} />}
      </button>

      <input
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleSendTextMessage();
          }
        }}
        type="text"
        placeholder="Type a message..."
        id="textMessageInput"
        name="textMessageInput"
        className="border border-gray-300 rounded-full p-3 flex-1 min-w-0"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <button
        className="p-3 sm:px-4 sm:py-2 bg-byuRoyal hover:bg-byuNavy text-white rounded-full flex items-center justify-center"
        onClick={handleSendTextMessage}
        title="Send"
      >
        {/* Icon is visible only on small screens */}
        <span className="sm:hidden">
          <Send size={18} />
        </span>
        {/* Text is hidden on small screens and visible on larger screens */}
        <span className="hidden sm:inline">Send</span>
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
  onOpenSettings,
}) {
  return (
    <div className="flex gap-4 border-t-2 border-gray-200 h-full pt-4">
      {isSessionActive ? (
        <SessionActive
          stopSession={stopSession}
          sendTextMessage={sendTextMessage}
          localStream={localStream}
        />
      ) : (
        <SessionStopped startSession={startSession} onOpenSettings={onOpenSettings} />
      )}
    </div>
  );
}