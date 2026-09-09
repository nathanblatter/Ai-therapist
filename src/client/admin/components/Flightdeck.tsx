// Flightdeck findings view: the ai-therapist items in the flightdeck tracker
// (stress-test findings, in-app bug reports, agent-filed work), read-only.
// Data: GET /admin/api/flightdeck/findings (therapist/researcher; 503 until
// FLIGHTDECK_READ_KEY is configured).
import { useState } from "react";
import { AlertOctagon, CheckSquare, Zap, FileText, RefreshCw, Flag } from "react-feather";
import useAdminFetch from "../hooks/useAdminFetch";
import Panel from "./ui/Panel";

interface FindingItem {
  ref: string;
  type: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  source: string;
  tags: string[];
  created_at: string | null;
  updated_at: string | null;
  open: boolean;
}

const TYPE_ICONS: Record<string, typeof CheckSquare> = {
  bug: AlertOctagon,
  task: CheckSquare,
  idea: Zap,
  note: FileText,
};

const STATUS_STYLES: Record<string, string> = {
  backlog: "bg-gray-100 text-gray-700",
  todo: "bg-blue-100 text-blue-800",
  in_progress: "bg-yellow-100 text-yellow-800",
  blocked: "bg-red-100 text-red-800",
  done: "bg-green-100 text-green-800",
  wontfix: "bg-gray-100 text-gray-500",
};

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  med: "bg-gray-100 text-gray-600",
  low: "bg-gray-100 text-gray-500",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Flightdeck() {
  const { data, loading, error, refetch } = useAdminFetch<{ items: FindingItem[] }>(
    "/admin/api/flightdeck/findings"
  );
  const [showClosed, setShowClosed] = useState(false);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

  const items = data?.items ?? [];
  const visible = showClosed ? items : items.filter((i) => i.open);
  const openCount = items.filter((i) => i.open).length;
  const reportCount = items.filter((i) => i.source === "bug_reporter" && i.open).length;

  return (
    <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <Flag size={20} aria-hidden="true" /> Findings
          </h1>
          <p className="text-sm text-gray-500">
            Issues and findings tracked in flightdeck for this app, including in-app bug
            reports. {openCount} open{reportCount > 0 ? ` (${reportCount} from in-app reports)` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            Show closed
          </label>
          <button
            onClick={refetch}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 text-gray-700"
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      {loading && <div className="text-gray-500 p-8 text-center">Loading findings…</div>}
      {error && (
        <Panel>
          <div className="text-sm text-gray-600 p-2">
            Could not load findings ({error}). The tracker may not be configured for this
            environment.
          </div>
        </Panel>
      )}

      {!loading && !error && visible.length === 0 && (
        <Panel>
          <div className="text-sm text-gray-500 p-4 text-center">
            No {showClosed ? "" : "open "}findings. New in-app bug reports appear here a few
            seconds after they are filed.
          </div>
        </Panel>
      )}

      {!loading && !error && visible.length > 0 && (
        <Panel>
          <ul className="divide-y divide-gray-100">
            {visible.map((item) => {
              const TypeIcon = TYPE_ICONS[item.type] ?? CheckSquare;
              const expanded = expandedRef === item.ref;
              return (
                <li key={item.ref}>
                  <button
                    className="w-full text-left px-3 py-2.5 hover:bg-gray-50 focus-visible:bg-gray-50"
                    onClick={() => setExpandedRef(expanded ? null : item.ref)}
                    aria-expanded={expanded}
                  >
                    <div className="flex items-start gap-3">
                      <TypeIcon size={16} className="mt-0.5 shrink-0 text-gray-400" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-gray-400">{item.ref}</span>
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[item.status] ?? STATUS_STYLES.backlog}`}>
                            {item.status.replace("_", " ")}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-xs ${PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.med}`}>
                            {item.priority}
                          </span>
                          {item.source === "bug_reporter" && (
                            <span className="px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-800">
                              in-app report
                            </span>
                          )}
                          <span className="text-xs text-gray-400 ml-auto shrink-0">
                            {relativeTime(item.updated_at)}
                          </span>
                        </div>
                        <div className="text-sm text-gray-900 mt-0.5">{item.title}</div>
                        {expanded && item.body && (
                          <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{item.body}</p>
                        )}
                        {expanded && item.tags.length > 0 && (
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {item.tags.map((t) => (
                              <span key={t} className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-500">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </div>
  );
}
