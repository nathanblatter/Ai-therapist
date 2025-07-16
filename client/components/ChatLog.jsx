import React from "react";

export default function ChatLog({ messages }) {
  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto">
      {messages.map((msg, idx) => (
        <div
          key={idx}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-xs px-4 py-2 rounded-2xl whitespace-pre-line ${
              msg.role === "user"
                ? "bg-blue-500 text-white rounded-br-none"
                : "bg-gray-200 text-black rounded-bl-none"
            }`}
          >
            {msg.text}
          </div>
        </div>
      ))}
    </div>
  );
}
