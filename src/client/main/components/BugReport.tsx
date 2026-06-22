import { useEffect, useRef, useState } from "react";

const SEVERITIES = [
  { value: "low", label: "Minor — a small annoyance" },
  { value: "med", label: "Medium — gets in the way" },
  { value: "high", label: "High — hard to use" },
  { value: "urgent", label: "Urgent — not working at all" },
];

type Status = "idle" | "sending" | "sent" | "error";

export default function BugReport() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState("med");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Client-only — avoids any SSR hydration mismatch.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    const id = window.setTimeout(() => ref.current?.focus(), 40);
    return () => { document.removeEventListener("keydown", onKey); window.clearTimeout(id); };
  }, [open]);

  function close() {
    setOpen(false);
    window.setTimeout(() => { setMessage(""); setSeverity("med"); setStatus("idle"); setError(""); }, 200);
  }

  async function send() {
    const trimmed = message.trim();
    if (!trimmed) { setError("A few words first, please."); ref.current?.focus(); return; }
    setStatus("sending"); setError("");
    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          severity,
          url: window.location.href,
          meta: { path: window.location.pathname, viewport: `${window.innerWidth}x${window.innerHeight}`, userAgent: navigator.userAgent },
        }),
      });
      if (!res.ok) throw new Error();
      setStatus("sent");
      window.setTimeout(close, 1400);
    } catch {
      setStatus("error"); setError("Could not send. Please try again.");
    }
  }

  if (!mounted) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Report a problem"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-royal px-4 py-3
                   text-sm font-medium text-white shadow-lg shadow-royal/25 transition
                   hover:-translate-y-0.5 hover:bg-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-lightBlue"
      >
        <span aria-hidden="true">💬</span>
        <span className="hidden sm:inline">Report a problem</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4 backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div role="dialog" aria-modal="true" aria-label="Report a problem"
               className="w-full max-w-md rounded-2xl border border-lightBlue bg-white p-6 shadow-2xl">
            <h2 className="text-xl font-semibold text-navy">Something not working?</h2>
            <p className="mt-1 text-sm text-gray-500">
              Let us know what happened — it helps us make this better.
            </p>

            {status === "sent" ? (
              <div className="mt-6 rounded-xl bg-lightBlue/30 px-4 py-6 text-center text-sm font-medium text-navy">
                Thank you — your note has been sent.
              </div>
            ) : (
              <>
                <label htmlFor="ai-bug-msg" className="mt-5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  What happened?
                </label>
                <textarea id="ai-bug-msg" ref={ref} value={message} onChange={(e) => setMessage(e.target.value)}
                  rows={4} maxLength={5000} placeholder="What you saw, and what you expected…"
                  className="mt-2 w-full resize-y rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-navy
                             placeholder-gray-400 focus:border-royal focus:outline-none focus:ring-2 focus:ring-royal/20" />

                <label htmlFor="ai-bug-sev" className="mt-4 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  How much does it affect you?
                </label>
                <select id="ai-bug-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 p-2.5 text-sm text-navy focus:border-royal focus:outline-none focus:ring-2 focus:ring-royal/20">
                  {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>

                <div className="mt-5 flex items-center gap-3">
                  <span className="mr-auto text-xs text-red-500">{error}</span>
                  <button type="button" onClick={close} className="text-sm font-medium text-gray-400 transition hover:text-gray-700">Cancel</button>
                  <button type="button" onClick={send} disabled={status === "sending"}
                    className="rounded-xl bg-royal px-4 py-2 text-sm font-medium text-white transition hover:bg-navy disabled:opacity-60">
                    {status === "sending" ? "Sending…" : "Send"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
