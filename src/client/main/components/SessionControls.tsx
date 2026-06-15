import { useState, useRef, useEffect } from "react";
import { Mic, MicOff, PhoneOff, Send, Play, Settings, AlertCircle } from "react-feather";
import { toast } from '../../shared/components/Toast';

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
        className="p-3 bg-byuRoyal hover:bg-green-700 text-white rounded-full font-semibold px-4 py-3 flex items-center justify-center gap-2 min-h-[44px] min-w-[44px]"
        onClick={handleStartSession}
        disabled={isActivating}
        aria-label="Start new therapy session"
      >
        <span className="">Start Session</span>
      </button>
      <button
        className="p-3 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-full flex items-center justify-center min-h-[44px] min-w-[44px]"
        onClick={onOpenSettings}
        aria-label="Open session settings"
      >
        <Settings size={20} />
      </button>
    </div>
  );
}

function SessionActive({ stopSession, sendTextMessage, localStream, chatEnabled, sessionType }) {
  const [message, setMessage] = useState("");
  const [isMicOn, setIsMicOn] = useState(true);
  const [micPermission, setMicPermission] = useState('unknown'); // 'granted', 'denied', 'prompt', 'unknown'
  const streamRef = useRef(null);

  useEffect(() => {
    // Check microphone permission status
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' })
        .then(permissionStatus => {
          setMicPermission(permissionStatus.state);

          // Listen for permission changes
          permissionStatus.onchange = () => {
            setMicPermission(permissionStatus.state);
            if (permissionStatus.state === 'denied') {
              toast.error('Microphone access denied. Please enable microphone permissions in your browser settings.');
            } else if (permissionStatus.state === 'granted') {
              toast.success('Microphone access granted');
            }
          };
        })
        .catch(() => {
          setMicPermission('unknown');
        });
    }

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

  const isChatOnly = sessionType === 'chat';
  // Show text input if: chat-only mode OR (voice mode AND chat enabled)
  const showTextInput = isChatOnly || chatEnabled;

  return (
    <div className={`flex items-center gap-2 w-full h-full ${!showTextInput ? 'justify-center' : ''}`}>
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

      {/* Only show mic button in realtime (voice) mode */}
      {!isChatOnly && (
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={toggleMic}
            className={`p-3 sm:px-4 sm:py-2 rounded-full ${
              micPermission === 'denied'
                ? "bg-gray-400 cursor-not-allowed"
                : isMicOn
                ? "bg-green-600 hover:bg-green-700"
                : "bg-red-600 hover:bg-red-700"
            } text-white flex items-center justify-center gap-2`}
            title={
              micPermission === 'denied'
                ? "Microphone access denied - check browser permissions"
                : isMicOn
                ? "Click to mute microphone"
                : "Click to unmute microphone"
            }
            disabled={micPermission === 'denied'}
            aria-label={
              micPermission === 'denied'
                ? "Microphone access denied"
                : isMicOn
                ? "Microphone on, click to mute"
                : "Microphone off, click to unmute"
            }
          >
            {micPermission === 'denied' ? (
              <AlertCircle size={18} />
            ) : isMicOn ? (
              <Mic size={18} />
            ) : (
              <MicOff size={18} />
            )}
            <span className="hidden sm:inline text-sm font-medium">
              {micPermission === 'denied'
                ? "Permission Denied"
                : isMicOn
                ? "Mic On"
                : "Mic Off"}
            </span>
          </button>
          {micPermission === 'denied' && (
            <span className="text-xs text-red-600 font-medium" role="alert">
              Enable microphone access
            </span>
          )}
        </div>
      )}

      {/* Only show text input and send button if chat is enabled */}
      {showTextInput && (
        <>
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
        </>
      )}
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
  chatEnabled,
  sessionType,
}) {
  return (
    <div className="flex gap-4 border-t-2 border-gray-200 h-full pt-4">
      {isSessionActive ? (
        <SessionActive
          stopSession={stopSession}
          sendTextMessage={sendTextMessage}
          localStream={localStream}
          chatEnabled={chatEnabled}
          sessionType={sessionType}
        />
      ) : (
        <SessionStopped startSession={startSession} onOpenSettings={onOpenSettings} />
      )}
    </div>
  );
}