import React from 'react';

// Single source of truth for the client-side chat message shape (App.tsx
// imports this type instead of re-declaring it).
export interface ChatMessage {
  id: string;
  role: string;
  text: string;
  isAdminMessage?: boolean;
}

interface ChatLogProps {
  messages: ChatMessage[];
  assistantStream: string;
  /** Fired (throttled) when the participant scrolls back up through earlier
   *  messages — Phase 2 engagement telemetry; no-op when unset/disabled. */
  onScrollBack?: () => void;
}

// A participant is "scrolled back" once they are this far above the bottom.
const SCROLL_BACK_PX = 300;
const SCROLL_BACK_THROTTLE_MS = 15_000;
// Within this distance of the bottom the log follows new messages; further up,
// the participant is reading back and is left where they are.
const FOLLOW_PX = 80;

export default function ChatLog({ messages, assistantStream, onScrollBack }: ChatLogProps) {
  const lastScrollBackAt = React.useRef(0);
  const logRef = React.useRef<HTMLDivElement>(null);
  const followRef = React.useRef(true);

  // Keep the newest turn in view (on a phone the latest reply otherwise lands
  // below the fold), unless the participant has scrolled up to read back.
  React.useLayoutEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, assistantStream]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const fromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    followRef.current = fromBottom < FOLLOW_PX;
    if (!onScrollBack) return;
    if (fromBottom < SCROLL_BACK_PX) return;
    const now = Date.now();
    if (now - lastScrollBackAt.current < SCROLL_BACK_THROTTLE_MS) return;
    lastScrollBackAt.current = now;
    onScrollBack();
  }

  return (
    <div
      ref={logRef}
      className="flex-grow flex-col gap-3 py-4 sm:p-4 overflow-y-auto h-full"
      role="log"
      aria-label="Conversation messages"
      aria-live="polite"
      aria-relevant="additions"
      onScroll={handleScroll}
    >
      {messages.length === 0 && !assistantStream ? (
        <p className="text-gray-400 text-2xl text-center" role="status">
          Start talking or type in the chat bar to begin...
        </p>
      ) : (
        messages.map((msg: ChatMessage) => (
          <div
            key={msg.id}
            className={`flex w-full ${
              msg.role === 'system' ? 'justify-center' : msg.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
            role="article"
            aria-label={`${msg.role === 'user' ? 'Your message' : msg.role === 'assistant' ? 'Therapist message' : 'System message'}`}
          >
            <div
              className={`max-w-[85%] sm:max-w-md lg:max-w-lg px-4 py-2 rounded-2xl whitespace-pre-line ${
                msg.role === 'system'
                  ? 'bg-yellow-100 text-yellow-900 border-2 border-yellow-400 italic text-sm font-medium mb-2'
                  : msg.role === 'user'
                    ? 'bg-royal text-white rounded-br-none mb-1 font-semibold'
                    : 'bg-lightBlue text-black rounded-bl-none font-semibold mb-2'
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))
      )}

      {assistantStream && (
        <div className="flex justify-start" role="status" aria-label="Therapist is typing">
          <div
            className="max-w-[85%] sm:max-w-md lg:max-w-lg px-4 py-2 rounded-2xl bg-gray-200 text-black rounded-bl-none opacity-70 whitespace-pre-line"
            aria-live="assertive"
          >
            {assistantStream}
          </div>
        </div>
      )}
    </div>
  );
}
