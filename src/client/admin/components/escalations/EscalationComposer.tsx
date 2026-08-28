// Escalation composer modal (caseworker portal slice B). Raises a structured
// escalation about a caseload client via POST /admin/api/escalations. Used
// from the inbox (client picked from my caseload), from CaseloadView's
// per-client Escalate action, and from CrisisManagement with a pre-linked
// crisis event (integration wiring).
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "react-feather";

interface CaseloadClient {
  userid: number;
  username: string;
}

interface EscalationComposerProps {
  /** Preselected client (CaseloadView / CrisisManagement entry points). */
  clientId?: number;
  clientName?: string;
  /** Optional pre-linked context. */
  sessionId?: string | null;
  crisisEventId?: number | null;
  onClose: () => void;
  onCreated?: (escalation: unknown) => void;
}

export default function EscalationComposer({
  clientId,
  clientName,
  sessionId,
  crisisEventId,
  onClose,
  onCreated,
}: EscalationComposerProps) {
  const [clients, setClients] = useState<CaseloadClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(clientId ?? null);
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState<"routine" | "urgent" | "emergency">("routine");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No preselected client: offer my caseload. When a crisis event or session
  // is pre-linked, NEVER auto-select a caseload client — a silent default
  // would file the escalation about the wrong person; the caller must pick.
  useEffect(() => {
    if (clientId !== undefined) return;
    let cancelled = false;
    fetch("/admin/api/caseload", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list: CaseloadClient[] = Array.isArray(data?.clients) ? data.clients : [];
        setClients(list);
        if (list.length > 0 && crisisEventId == null && sessionId == null) {
          setSelectedClientId((prev) => prev ?? list[0].userid);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clientId, crisisEventId, sessionId]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (selectedClientId === null) {
      setError("Pick a client to escalate about.");
      return;
    }
    if (!reason.trim()) {
      setError("Describe why you are escalating.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/admin/api/escalations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          client_id: selectedClientId,
          reason: reason.trim(),
          urgency,
          session_id: sessionId ?? undefined,
          crisis_event_id: crisisEventId ?? undefined,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create escalation");
      }
      const data = await response.json();
      onCreated?.(data.escalation);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New escalation"
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500" aria-hidden="true" />
            Escalate to the care team
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-2"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {clientId !== undefined ? (
            <p className="text-sm text-gray-700">
              About <span className="font-medium">{clientName ?? `client ${clientId}`}</span>
            </p>
          ) : (
            <div>
              <label htmlFor="escalation-client" className="block text-sm font-medium text-gray-700 mb-1">
                Client
              </label>
              <select
                id="escalation-client"
                value={selectedClientId ?? ""}
                onChange={(e) => setSelectedClientId(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]"
              >
                {selectedClientId === null && (
                  <option value="" disabled>
                    Select a client
                  </option>
                )}
                {clients.map((c) => (
                  <option key={c.userid} value={c.userid}>
                    {c.username}
                  </option>
                ))}
              </select>
              {clients.length === 0 && (
                <p className="text-xs text-gray-500 mt-1">No clients on your caseload yet.</p>
              )}
            </div>
          )}

          <div>
            <label htmlFor="escalation-urgency" className="block text-sm font-medium text-gray-700 mb-1">
              Urgency
            </label>
            <select
              id="escalation-urgency"
              value={urgency}
              onChange={(e) => setUrgency(e.target.value as "routine" | "urgent" | "emergency")}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]"
            >
              <option value="routine">Routine — review when you can</option>
              <option value="urgent">Urgent — needs attention today</option>
              <option value="emergency">Emergency — immediate clinical attention</option>
            </select>
          </div>

          <div>
            <label htmlFor="escalation-reason" className="block text-sm font-medium text-gray-700 mb-1">
              Reason
            </label>
            <textarea
              id="escalation-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="What changed, what you observed, and what you need from the therapist..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal text-sm"
            />
          </div>

          {crisisEventId != null && (
            <p className="text-xs text-gray-500">Linked to crisis event #{crisisEventId}.</p>
          )}

          {error && (
            <div className="text-red-600 text-sm" role="alert">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 min-h-[44px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-royal text-white rounded-md hover:bg-blue-700 disabled:opacity-50 min-h-[44px]"
            >
              {submitting ? "Escalating..." : "Raise escalation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
