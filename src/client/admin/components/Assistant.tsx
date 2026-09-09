// Admin assistant (docs/admin-assistant-spec.md): natural-language questions
// over the caller's own data access. Read-only; every answer shows which
// lookups ran. History lives in this tab only — the durable record is the
// server-side assistant_audit table.
import { useRef, useState, useEffect } from "react";
import { Send, MessageCircle, Database } from "react-feather";

interface TurnToolCall { name: string; rowCount: number }
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: TurnToolCall[];
}

const QUICK_PROMPTS: Record<string, string[]> = {
  researcher: [
    "How is survey completion looking this week?",
    "Any crisis events in the last 7 days?",
    "Summarize the instrument aggregates.",
  ],
  therapist: [
    "Summarize my caseload's recent activity.",
    "Which of my clients have open escalations?",
    "Who on my caseload hasn't had a session in 10 days?",
  ],
  caseworker: [
    "What's in my work queue?",
    "Which of my clients had a risk signal this week?",
  ],
};

const TOOL_LABELS: Record<string, string> = {
  study_overview: "study overview",
  survey_completion: "survey completion",
  session_stats: "session stats",
  crisis_events: "crisis events",
  escalations: "escalations",
  work_queue: "work queue",
  caseload_roster: "caseload roster",
  user_lookup: "user lookup",
};

export default function Assistant({ role }: { role: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/admin/api/assistant/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.slice(-12).map(({ role: r, content }) => ({ role: r, content })),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { answer?: string; toolCalls?: TurnToolCall[]; error?: string }
        | null;
      if (!res.ok || !data?.answer) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      setMessages((prev) => [...prev, { role: "assistant", content: data.answer!, toolCalls: data.toolCalls }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      setMessages((prev) => prev.slice(0, -1));
      setInput(question);
    } finally {
      setBusy(false);
    }
  };

  const prompts = QUICK_PROMPTS[role ?? ""] ?? [];

  return (
    <div className="h-full flex flex-col p-4 md:p-6 max-w-3xl mx-auto w-full">
      <div className="mb-3">
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <MessageCircle size={20} aria-hidden="true" /> Assistant
        </h1>
        <p className="text-sm text-gray-500">
          Ask about the data your role can already see. The assistant works with aggregates,
          scores, and statuses only, and never with session transcripts or message content.
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-white rounded-lg shadow p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-sm text-gray-500 space-y-3">
            <p>Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {prompts.map((p) => (
                <button
                  key={p}
                  onClick={() => void send(p)}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-full bg-gray-50 hover:bg-gray-100 text-gray-700"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "bg-blue-600 text-white rounded-lg px-3 py-2 max-w-[85%] text-sm whitespace-pre-wrap"
                  : "bg-gray-100 text-gray-900 rounded-lg px-3 py-2 max-w-[85%] text-sm whitespace-pre-wrap"
              }
            >
              {m.content}
              {m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mt-2 pt-2 border-t border-gray-200 flex items-center gap-1.5 flex-wrap text-xs text-gray-500">
                  <Database size={12} aria-hidden="true" />
                  {m.toolCalls.map((t, j) => (
                    <span key={j} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded">
                      {TOOL_LABELS[t.name] ?? t.name} ({t.rowCount})
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-sm text-gray-400">Looking that up…</div>}
      </div>

      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your data…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50 hover:bg-blue-700"
        >
          <Send size={14} aria-hidden="true" /> Ask
        </button>
      </form>
      <p className="mt-2 text-xs text-gray-400">
        Answers are computed from your own data access. Verify anything consequential in the
        underlying panel.
      </p>
    </div>
  );
}
