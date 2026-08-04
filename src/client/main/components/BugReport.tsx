import { useEffect, useRef, useState } from "react";

const SEVERITIES = [
  { value: "low", label: "Minor — a small annoyance" },
  { value: "med", label: "Medium — gets in the way" },
  { value: "high", label: "High — hard to use" },
  { value: "urgent", label: "Urgent — not working at all" },
];

const MAX_SHOTS = 4;
const MAX_SHOT_BYTES = 8 * 1024 * 1024; // 8MB, matches the server cap
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type Status = "idle" | "sending" | "sent" | "error";

type Shot = { file: File; preview: string };

export default function BugReport() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState("med");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [shotError, setShotError] = useState("");
  const [shotWarning, setShotWarning] = useState("");
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  // Client-only — avoids any SSR hydration mismatch.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); addShots(files); }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    const id = window.setTimeout(() => ref.current?.focus(), 40);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
      window.clearTimeout(id);
    };
  }, [open]);

  // Revoke any remaining object URLs on unmount.
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.preview)), []);

  function close() {
    setOpen(false);
    window.setTimeout(() => {
      shotsRef.current.forEach((s) => URL.revokeObjectURL(s.preview));
      setMessage(""); setSeverity("med"); setStatus("idle"); setError("");
      setShots([]); setShotError(""); setShotWarning(""); setDragging(false);
    }, 200);
  }

  function addShots(files: File[]) {
    setShotError("");
    setShots((prev) => {
      const next = [...prev];
      const errors: string[] = [];
      for (const file of files) {
        if (next.length >= MAX_SHOTS) { errors.push(`Up to ${MAX_SHOTS} screenshots per report.`); break; }
        if (!IMAGE_TYPES.includes(file.type)) { errors.push(`${file.name || "That file"} isn't an image we can accept (PNG, JPEG, WebP, or GIF).`); continue; }
        if (file.size > MAX_SHOT_BYTES) { errors.push(`${file.name || "That image"} is over 8MB.`); continue; }
        next.push({ file, preview: URL.createObjectURL(file) });
      }
      if (errors.length) setShotError(errors[0]);
      return next;
    });
  }

  function removeShot(idx: number) {
    setShots((prev) => {
      const shot = prev[idx];
      if (shot) URL.revokeObjectURL(shot.preview);
      return prev.filter((_, i) => i !== idx);
    });
    setShotError("");
  }

  async function send() {
    const trimmed = message.trim();
    if (!trimmed) { setError("A few words first, please."); ref.current?.focus(); return; }
    setStatus("sending"); setError(""); setShotWarning("");
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
      const { id } = (await res.json().catch(() => ({}))) as { id?: string };

      // Screenshots are best-effort: the report itself has already been filed.
      if (shots.length && id) {
        try {
          const form = new FormData();
          shots.forEach((s) => form.append("files", s.file, s.file.name || "screenshot.png"));
          const up = await fetch(`/api/bug-report/${id}/screenshots`, { method: "POST", body: form });
          if (!up.ok) throw new Error();
        } catch {
          setShotWarning("Your note was sent, but the screenshots didn't go through.");
        }
      } else if (shots.length && !id) {
        setShotWarning("Your note was sent, but the screenshots didn't go through.");
      }

      setStatus("sent");
      window.setTimeout(close, shots.length ? 2200 : 1400);
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
        className="fixed bottom-24 right-4 sm:bottom-5 sm:right-5 z-30 flex items-center gap-2 rounded-full bg-royal px-4 py-3
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
                {shotWarning && <div className="mt-2 text-xs font-normal text-amber-600">{shotWarning}</div>}
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

                <span className="mt-4 block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Screenshots <span className="font-normal normal-case text-gray-400">(optional, up to {MAX_SHOTS})</span>
                </span>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
                  onDrop={(e) => {
                    e.preventDefault(); setDragging(false);
                    addShots(Array.from(e.dataTransfer.files || []));
                  }}
                  onClick={() => shots.length < MAX_SHOTS && fileRef.current?.click()}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileRef.current?.click())}
                  aria-label="Add screenshots"
                  className={`mt-2 rounded-xl border border-dashed p-3 text-center transition cursor-pointer
                              ${dragging ? "border-royal bg-royal/5" : "border-gray-200 bg-gray-50 hover:border-royal/50"}`}
                >
                  {shots.length > 0 ? (
                    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                      {shots.map((s, i) => (
                        <div key={s.preview} className="relative">
                          <img src={s.preview} alt={s.file.name || `Screenshot ${i + 1}`}
                               className="h-16 w-16 rounded-lg border border-gray-200 object-cover" />
                          <button type="button" onClick={() => removeShot(i)}
                            aria-label={`Remove ${s.file.name || `screenshot ${i + 1}`}`}
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full
                                       bg-navy text-[10px] leading-none text-white shadow transition hover:bg-red-500">
                            ✕
                          </button>
                        </div>
                      ))}
                      {shots.length < MAX_SHOTS && (
                        <button type="button" onClick={() => fileRef.current?.click()} aria-label="Add another screenshot"
                          className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-gray-300
                                     text-xl text-gray-400 transition hover:border-royal/50 hover:text-royal">
                          +
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">
                      Click, drag &amp; drop, or paste images here — PNG, JPEG, WebP, or GIF, 8MB max each.
                    </p>
                  )}
                </div>
                <input ref={fileRef} type="file" multiple accept={IMAGE_TYPES.join(",")} className="hidden"
                  onChange={(e) => {
                    addShots(Array.from(e.target.files || []));
                    e.target.value = "";
                  }} />
                {shotError && <p className="mt-1.5 text-xs text-red-500">{shotError}</p>}

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
