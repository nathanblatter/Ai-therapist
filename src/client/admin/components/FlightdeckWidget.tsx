// Floating flightdeck widget (admin portal): the counterpart to the
// participant side's "Report a problem" pill. A bottom-right button with an
// open-findings badge; the panel shows the freshest open findings, offers a
// quick report box (same public /api/bug-report ingest the participant widget
// uses), and links to the full Findings view.
import { useEffect, useRef, useState } from "react";
import { Flag, X, ArrowRight } from "react-feather";

interface FindingItem {
  ref: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  source: string;
  updated_at: string | null;
  open: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  backlog: "bg-gray-100 text-gray-700",
  todo: "bg-blue-100 text-blue-800",
  in_progress: "bg-yellow-100 text-yellow-800",
  blocked: "bg-red-100 text-red-800",
};

const PANEL_ITEMS = 8;

type ReportStatus = "idle" | "sending" | "sent" | "error";

export default function FlightdeckWidget({ onOpenFull }: { onOpenFull: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FindingItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState("");
  const [reportStatus, setReportStatus] = useState<ReportStatus>("idle");
  const panelRef = useRef<HTMLDivElement>(null);

  const load = () => {
    fetch("/admin/api/flightdeck/findings", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { items: FindingItem[] }) => {
        setItems(data.items);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  };

  useEffect(load, []);
  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Findings access is therapist/researcher; a 403/503 hides the widget
  // entirely rather than showing a dead pill.
  if (loadError && items === null) return null;

  const openItems = (items ?? []).filter((i) => i.open);

  const sendReport = async () => {
    const body = message.trim();
    if (!body || reportStatus === "sending") return;
    setReportStatus("sending");
    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: body, severity: "med", url: window.location.href, meta: { surface: "admin-widget" } }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMessage("");
      setReportStatus("sent");
      window.setTimeout(() => setReportStatus("idle"), 2500);
      load();
    } catch {
      setReportStatus("error");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Findings"
        aria-expanded={open}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-blue-700 px-4 py-3
                   text-sm font-medium text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-blue-800
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
      >
        <Flag size={16} aria-hidden="true" />
        <span className="hidden sm:inline">Findings</span>
        {openItems.length > 0 && (
          <span className="ml-0.5 rounded-full bg-white/20 px-1.5 py-0.5 text-xs font-semibold">
            {openItems.length}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Findings"
          className="fixed bottom-20 right-5 z-40 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-xl border border-gray-200
                     bg-white shadow-2xl flex flex-col max-h-[70vh]"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="text-sm font-semibold text-gray-900">
              Findings <span className="text-gray-400 font-normal">({openItems.length} open)</span>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close" className="text-gray-400 hover:text-gray-600">
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1">
            {items === null && <div className="p-4 text-sm text-gray-400">Loading…</div>}
            {items !== null && openItems.length === 0 && (
              <div className="p-4 text-sm text-gray-500">No open findings.</div>
            )}
            <ul className="divide-y divide-gray-50">
              {openItems.slice(0, PANEL_ITEMS).map((i) => (
                <li key={i.ref} className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono text-[11px] text-gray-400">{i.ref}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${STATUS_STYLES[i.status] ?? STATUS_STYLES.backlog}`}>
                      {i.status.replace("_", " ")}
                    </span>
                    {i.priority === "urgent" || i.priority === "high" ? (
                      <span className="px-1.5 py-0.5 rounded text-[11px] bg-orange-100 text-orange-800">{i.priority}</span>
                    ) : null}
                    {i.source === "bug_reporter" && (
                      <span className="px-1.5 py-0.5 rounded text-[11px] bg-purple-100 text-purple-800">report</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-800 mt-0.5 line-clamp-2">{i.title}</div>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-gray-100 px-4 py-3 space-y-2">
            {reportStatus === "sent" ? (
              <div className="text-sm text-green-700">Thanks — filed.</div>
            ) : (
              <div className="flex gap-2">
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void sendReport()}
                  placeholder="Spot something? File it…"
                  maxLength={5000}
                  className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm
                             focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <button
                  onClick={() => void sendReport()}
                  disabled={reportStatus === "sending" || !message.trim()}
                  className="rounded-lg bg-blue-700 px-3 py-1.5 text-sm text-white disabled:opacity-50 hover:bg-blue-800"
                >
                  File
                </button>
              </div>
            )}
            {reportStatus === "error" && <div className="text-xs text-red-600">Could not file that — try again.</div>}
            <button
              onClick={() => {
                setOpen(false);
                onOpenFull();
              }}
              className="flex items-center gap-1 text-xs text-blue-700 hover:text-blue-900"
            >
              Open full Findings view <ArrowRight size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
