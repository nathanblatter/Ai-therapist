import { useState } from "react";
import { CloudLightning, CloudOff, MessageSquare, Mic } from "react-feather";
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
      <Button
        onClick={handleStartSession}
        className={isActivating ? "bg-gray-600" : "bg-red-600"}
        icon={<CloudLightning height={16} />}
      >
        {isActivating ? "starting session..." : "start session"}
      </Button>
    </div>
  );
}

function SessionActive({ stopSession, sendTextMessage }) {
  const [message, setMessage] = useState("");

  function handleSendClientEvent() {
    sendTextMessage(message);
    setMessage("");
  }

  return (
    <div className="flex items-center gap-2 w-full h-full">
      <button
        className="p-3 bg-gray-200 rounded-full"
        onClick={stopSession}
        title="disconnect"
      >
        <CloudOff height={18} />
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
        className="p-3 bg-blue-500 text-white rounded-full"
        onClick={() => {
          if (message.trim()) {
            handleSendClientEvent();
          }
        }}
        title="send"
      >
        <MessageSquare height={18} />
      </button>
      <button className="p-3 bg-gray-200 rounded-full" title="mic">
        <Mic height={18} />
      </button>
    </div>
  );
}

export default function SessionControls({
  startSession,
  stopSession,
  sendClientEvent,
  sendTextMessage,
  serverEvents,
  isSessionActive,
}) {
  return (
    <div className="flex gap-4 border-t-2 border-gray-200 h-full rounded-md">
      {isSessionActive ? (
        <SessionActive
          stopSession={stopSession}
          sendClientEvent={sendClientEvent}
          sendTextMessage={sendTextMessage}
          serverEvents={serverEvents}
        />
      ) : (
        <SessionStopped startSession={startSession} />
      )}
    </div>
  );
}
