// Escalations inbox (caseworker portal slice B): the nav-level view over
// /admin/api/escalations. Care-team members see escalations they raised, are
// assigned, or that concern their caseload (plus the org unassigned queue for
// therapists); researchers see org-wide metadata. Row click opens
// EscalationDetail (timeline + lifecycle actions).
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle, Clock, Inbox, Plus } from "react-feather";
import useAdminFetch from "../../hooks/useAdminFetch";
import EscalationDetail from "./EscalationDetail";
import EscalationComposer from "./EscalationComposer";

export type EscalationStatus = "open" | "acknowledged" | "resolved";
export type EscalationUrgency = "routine" | "urgent" | "emergency";

export interface EscalationListRow {
  escalation_id: number;
  org_id: number;
  client_id: number;
  raised_by: number | null;
  raised_by_role: "caseworker" | "therapist";
  assigned_to: number | null;
  reason: string;
  urgency: EscalationUrgency;
  crisis_event_id: number | null;
  session_id: string | null;
  note_id: number | null;
  status: EscalationStatus;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
  client_username?: string | null;
  assigned_username?: string | null;
}

export function UrgencyBadge({ urgency }: { urgency: EscalationUrgency }) {
  if (urgency === "emergency") {
    return (
      <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">
        <AlertTriangle size={12} aria-hidden="true" /> Emergency
      </span>
    );
  }
  if (urgency === "urgent") {
    return (
      <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">
        <ArrowUpRight size={12} aria-hidden="true" /> Urgent
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-600">
      Routine
    </span>
  );
}

export function StatusBadge({ status }: { status: EscalationStatus }) {
  if (status === "resolved") {
    return (
      <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
        <CheckCircle size={12} aria-hidden="true" /> Resolved
      </span>
    );
  }
  if (status === "acknowledged") {
    return (
      <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
        <Clock size={12} aria-hidden="true" /> Acknowledged
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 inline-flex items-center gap-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
      Open
    </span>
  );
}

type Filter = "active" | "mine" | "resolved" | "all";

interface EscalationInboxProps {
  userRole: string | null;
}

export default function EscalationInbox({ userRole }: EscalationInboxProps) {
  const [filter, setFilter] = useState<Filter>("active");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);

  // The SPA shell only tracks the role; lifecycle actions (ack/resolve are
  // assignee-only) need my userid, so resolve it once here.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.authenticated && data.user) setCurrentUserId(data.user.userid);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const query =
    filter === "mine" ? "?mine=1" : filter === "resolved" ? "?status=resolved" : filter === "active" ? "?open_only=1" : "";
  const { data, loading, error, refetch } = useAdminFetch<{ escalations: EscalationListRow[] }>(
    `/admin/api/escalations${query}`
  );
  const escalations = useMemo(() => data?.escalations ?? [], [data]);

  const isCareTeam = userRole === "therapist" || userRole === "caseworker";

  if (selectedId !== null) {
    return (
      <EscalationDetail
        escalationId={selectedId}
        userRole={userRole}
        currentUserId={currentUserId}
        onBack={() => {
          setSelectedId(null);
          refetch();
        }}
      />
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Escalations</h2>
          <p className="text-gray-600 mt-1">
            Structured hand-offs between care-team members about a client&apos;s care.
          </p>
        </div>
        {isCareTeam && (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="px-4 py-2 bg-royal text-white rounded-md hover:bg-blue-700 flex items-center gap-2 min-h-[44px]"
          >
            <Plus size={16} aria-hidden="true" />
            New escalation
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-2 flex-wrap" role="tablist" aria-label="Escalation filters">
        {(
          [
            ["active", "Active"],
            ["mine", "Raised by me"],
            ["resolved", "Resolved"],
            ["all", "All"],
          ] as [Filter, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => setFilter(value)}
            className={`px-3 py-1.5 rounded-full text-sm min-h-[36px] ${
              filter === value ? "bg-royal text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden" role="region" aria-label="Escalations list">
        {loading ? (
          <div className="text-center py-8 text-gray-500">Loading escalations...</div>
        ) : escalations.length === 0 ? (
          <div className="text-center py-10 text-gray-500">
            <Inbox size={48} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
            <p>No escalations{filter === "active" ? " need attention" : ""}.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {escalations.map((e) => (
              <li key={e.escalation_id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(e.escalation_id)}
                  className="w-full text-left px-6 py-4 hover:bg-gray-50 focus:outline-none focus:bg-gray-50"
                  aria-label={`Open escalation ${e.escalation_id} for ${e.client_username ?? `client ${e.client_id}`}`}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <UrgencyBadge urgency={e.urgency} />
                      <StatusBadge status={e.status} />
                      <span className="text-sm font-medium text-gray-900">
                        {e.client_username ?? `Client ${e.client_id}`}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400">{new Date(e.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-700 line-clamp-2">{e.reason}</p>
                  <p className="mt-1 text-xs text-gray-400">
                    {e.assigned_to === null
                      ? "Unassigned (org queue)"
                      : `Assigned to ${e.assigned_username ?? `user ${e.assigned_to}`}`}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {composerOpen && (
        <EscalationComposer
          onClose={() => setComposerOpen(false)}
          onCreated={() => {
            setComposerOpen(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}
