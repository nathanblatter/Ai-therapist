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
      <button
        className="p-3 bg-blue-500 text-white rounded-full"
        onClick={handleStartSession}
        title="start session"
        disabled={isActivating}
      >
        <Mic height={18} />
      </button>
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
        // ... rest of your code
      />
    </div>
  );
}
