import React from "react";

export default function ChatLog({ messages, userStream, assistantStream }) {
  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto">
      {messages.length === 0 && !userStream && !assistantStream ? (
        <p className="text-gray-400 text-2xl text-center">Start talking or type in the chat bar to begin...</p>
      ) : (
        messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-xs px-4 py-2 rounded-2xl whitespace-pre-line ${
                msg.role === "user"
                  ? "bg-byuRoyal text-white rounded-br-none"
                  : "bg-gray-200 text-black rounded-bl-none"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))
      )}

      {userStream && (
        <div className="flex justify-end">
          <div className="max-w-xs px-4 py-2 rounded-2xl bg-byuRoyal text-white rounded-br-none opacity-70 whitespace-pre-line">
            {userStream}
          </div>
        </div>
      )}

      {assistantStream && (
        <div className="flex justify-start">
          <div className="max-w-xs px-4 py-2 rounded-2xl bg-gray-200 text-black rounded-bl-none opacity-70 whitespace-pre-line">
            {assistantStream}
          </div>
        </div>
      )}
    </div>
  );
}
