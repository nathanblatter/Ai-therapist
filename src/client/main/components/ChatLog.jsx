import React from "react";

export default function ChatLog({ messages, assistantStream }) {
  return (
    <div className="flex-grow flex-col gap-3 p-4 overflow-y-auto h-full">
      {messages.length === 0 && !assistantStream ? (
        <p className="text-gray-400 text-2xl text-center">Start talking or type in the chat bar to begin...</p>
      ) : (
        messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex w-full ${
              msg.role === "system" ? "justify-center" :
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-xs px-4 py-2 rounded-2xl whitespace-pre-line ${
                msg.role === "system"
                  ? "bg-yellow-100 text-yellow-900 border-2 border-yellow-400 italic text-sm font-medium mb-2"
                  : msg.role === "user"
                  ? "bg-byuRoyal text-white rounded-br-none mb-1 font-semibold"
                  : "bg-byuLightBlue text-black rounded-bl-none font-semibold mb-2"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))
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