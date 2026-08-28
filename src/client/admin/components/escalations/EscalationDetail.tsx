// Escalation detail (caseworker portal slice B): full record + event timeline
// with the lifecycle actions the server allows — acknowledge/resolve for the
// assigned therapist, claim for same-org therapists on unassigned
// escalations, reopen for the raiser/care team, comments for everyone who can
// see it. The server is the authority; buttons are shown optimistically by
// role and 403/409 responses surface inline.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, CornerUpLeft, MessageSquare, UserCheck } from "react-feather";
import { StatusBadge, UrgencyBadge, type EscalationListRow } from "./EscalationInbox";

interface EscalationEvent {
  event_id: number;
  escalation_id: number;
  event_type: "created" | "acknowledged" | "resolved" | "reopened" | "reassigned" | "claimed" | "comment";
  actor_user_id: number | null;
  actor_username: string | null;
  detail: { comment?: string; resolution_note?: string; urgency?: string } | null;
  created_at: string;
}

interface EscalationDetailProps {
  escalationId: number;
  userRole: string | null;
  currentUserId: number | null;
  onBack: () => void;
}

const EVENT_LABELS: Record<EscalationEvent["event_type"], string> = {
  created: "raised this escalation",
  acknowledged: "acknowledged",
  resolved: "resolved",
  reopened: "reopened",
  reassigned: "reassigned",
  claimed: "claimed from the unassigned queue",
  comment: "commented",
};

export default function EscalationDetail({ escalationId, userRole, currentUserId, onBack }: EscalationDetailProps) {
  const [escalation, setEscalation] = useState<EscalationListRow | null>(null);
  const [events, setEvents] = useState<EscalationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [showResolveForm, setShowResolveForm] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/admin/api/escalations/${escalationId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setEscalation(data.escalation);
      setEvents(data.events ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [escalationId]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/admin/api/escalations/${escalationId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Action failed (${res.status})`);
      }
      await fetchDetail();
      return true;
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleComment = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!comment.trim()) return;
    const ok = await act("comments", { comment: comment.trim() });
    if (ok) setComment("");
  };

  const isTherapist = userRole === "therapist";
  const isCareTeam = isTherapist || userRole === "caseworker";
  const isAssignee = escalation !== null && currentUserId !== null && escalation.assigned_to === currentUserId;
  const canAck = isTherapist && isAssignee && escalation?.status === "open";
  const canResolve = isTherapist && isAssignee && escalation !== null && escalation.status !== "resolved";
  const canClaim = isTherapist && escalation?.assigned_to === null && escalation?.status !== "resolved";
  const canReopen = isCareTeam && escalation?.status === "resolved";

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-royal hover:text-blue-700 flex items-center gap-1 min-h-[44px]"
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to escalations
      </button>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="text-gray-500 py-8 text-center">Loading escalation...</div>}

      {escalation && (
        <>
          <div className="bg-white rounded-lg shadow p-5 mb-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <UrgencyBadge urgency={escalation.urgency} />
              <StatusBadge status={escalation.status} />
              <span className="text-sm text-gray-400">#{escalation.escalation_id}</span>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              {escalation.client_username ?? `Client ${escalation.client_id}`}
            </h2>
            <p className="text-gray-800 whitespace-pre-wrap">{escalation.reason}</p>
            <dl className="mt-3 text-sm text-gray-500 space-y-0.5">
              <div>
                Assigned:{" "}
                {escalation.assigned_to === null
                  ? "unassigned (org queue)"
                  : escalation.assigned_username ?? `user ${escalation.assigned_to}`}
              </div>
              <div>Raised {new Date(escalation.created_at).toLocaleString()} by a {escalation.raised_by_role}</div>
              {escalation.crisis_event_id !== null && <div>Linked crisis event: #{escalation.crisis_event_id}</div>}
              {escalation.session_id !== null && <div>Linked session: {escalation.session_id}</div>}
              {escalation.resolution_note && (
                <div className="text-gray-700">Resolution: {escalation.resolution_note}</div>
              )}
            </dl>

            {actionError && (
              <div className="mt-3 text-red-600 text-sm" role="alert">
                {actionError}
              </div>
            )}

            <div className="mt-4 flex gap-2 flex-wrap">
              {canAck && (
                <button
                  type="button"
                  onClick={() => act("acknowledge")}
                  disabled={busy}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
                >
                  <CheckCircle size={16} aria-hidden="true" /> Acknowledge
                </button>
              )}
              {canResolve && !showResolveForm && (
                <button
                  type="button"
                  onClick={() => setShowResolveForm(true)}
                  disabled={busy}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
                >
                  <CheckCircle size={16} aria-hidden="true" /> Resolve
                </button>
              )}
              {canClaim && (
                <button
                  type="button"
                  onClick={() => act("claim")}
                  disabled={busy}
                  className="px-4 py-2 bg-royal text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
                  title="Claiming assigns this client to your caseload (audited)"
                >
                  <UserCheck size={16} aria-hidden="true" /> Claim
                </button>
              )}
              {canReopen && (
                <button
                  type="button"
                  onClick={() => act("reopen")}
                  disabled={busy}
                  className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
                >
                  <CornerUpLeft size={16} aria-hidden="true" /> Reopen
                </button>
              )}
            </div>

            {showResolveForm && (
              <form
                className="mt-3 space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await act("resolve", {
                    resolution_note: resolutionNote.trim() || undefined,
                  });
                  if (ok) setShowResolveForm(false);
                }}
              >
                <label htmlFor="resolution-note" className="block text-sm font-medium text-gray-700">
                  Resolution note (optional)
                </label>
                <textarea
                  id="resolution-note"
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal"
                  placeholder="What was done..."
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 min-h-[44px]"
                  >
                    Confirm resolve
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowResolveForm(false)}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 min-h-[44px]"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="bg-white rounded-lg shadow p-5" role="region" aria-label="Escalation timeline">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Timeline</h3>
            <ul className="space-y-3">
              {events.map((ev) => (
                <li key={ev.event_id} className="text-sm">
                  <div className="text-gray-800">
                    <span className="font-medium">{ev.actor_username ?? "system"}</span>{" "}
                    {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                    <span className="text-xs text-gray-400 ml-2">{new Date(ev.created_at).toLocaleString()}</span>
                  </div>
                  {ev.detail?.comment && (
                    <p className="mt-0.5 text-gray-700 bg-gray-50 rounded px-3 py-2 whitespace-pre-wrap">
                      {ev.detail.comment}
                    </p>
                  )}
                  {ev.detail?.resolution_note && (
                    <p className="mt-0.5 text-gray-700 bg-gray-50 rounded px-3 py-2 whitespace-pre-wrap">
                      {ev.detail.resolution_note}
                    </p>
                  )}
                </li>
              ))}
              {events.length === 0 && <li className="text-sm text-gray-500">No events recorded.</li>}
            </ul>

            <form onSubmit={handleComment} className="mt-4 flex gap-2 items-start">
              <label htmlFor="escalation-comment" className="sr-only">
                Add a comment
              </label>
              <textarea
                id="escalation-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Add a comment for the care team..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-royal"
              />
              <button
                type="submit"
                disabled={busy || !comment.trim()}
                className="px-4 py-2 bg-royal text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5 min-h-[44px]"
              >
                <MessageSquare size={16} aria-hidden="true" /> Comment
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
