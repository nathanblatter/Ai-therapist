import { useState } from "react";

import { CloudOff, MessageSquare, Mic, CloudLightning } from "react-feather";

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
        className="p-3 bg-byuRoyal hover:bg-gray-700 text-white rounded-full"
        onClick={handleStartSession}
        title="start session"
        disabled={isActivating}
      >
         Start Session
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
        className="p-3 bg-gray-200 hover:bg-red-700 hover:text-white rounded-full"
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
      className="p-3 bg-gray-200 rounded-full" 
      onClick={() => {

      }


      }
      title="mic">
        <Mic height={18} />
      </button>
    </div>
  );
}

export default function SessionControls({
  startSession,
  stopSession,
  sendTextMessage,
  isSessionActive,
}) {
  return (
    <div className="flex gap-4 border-t-2 border-gray-200 h-full rounded-md">
      {isSessionActive ? (
        <SessionActive
          stopSession={stopSession}
          sendTextMessage={sendTextMessage}
        />
      ) : (
        <SessionStopped startSession={startSession} />
      )}

      
    </div>
  );
}
