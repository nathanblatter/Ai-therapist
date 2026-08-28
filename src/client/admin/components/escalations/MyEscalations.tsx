// Compact "escalations I raised" strip (caseworker portal slice B). Embedded
// in ParticipantProfile (integration wiring; pass clientId to scope to one
// client) and usable on the caseworker dashboard. Read-only summary rows —
// the full lifecycle lives in EscalationInbox/EscalationDetail.
import { useMemo } from "react";
import { AlertTriangle } from "react-feather";
import useAdminFetch from "../../hooks/useAdminFetch";
import { StatusBadge, UrgencyBadge, type EscalationListRow } from "./EscalationInbox";

interface MyEscalationsProps {
  /** Scope to one client (e.g. the ParticipantProfile escalation strip). */
  clientId?: number;
  /** Only escalations I raised (mine=1); defaults to everything visible to me. */
  mineOnly?: boolean;
  limit?: number;
  /** Navigate to the escalations view (integration passes a nav callback). */
  onOpenEscalations?: () => void;
}

export default function MyEscalations({ clientId, mineOnly = true, limit = 5, onOpenEscalations }: MyEscalationsProps) {
  const params = new URLSearchParams();
  if (mineOnly) params.set("mine", "1");
  if (clientId !== undefined) params.set("client_id", String(clientId));
  const { data, loading, error } = useAdminFetch<{ escalations: EscalationListRow[] }>(
    `/admin/api/escalations?${params.toString()}`
  );
  const escalations = useMemo(() => (data?.escalations ?? []).slice(0, limit), [data, limit]);

  return (
    <div className="bg-white rounded-lg shadow p-4" role="region" aria-label="Escalations">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
          <AlertTriangle size={14} className="text-amber-500" aria-hidden="true" />
          {mineOnly ? "Escalations I raised" : "Escalations"}
        </h3>
        {onOpenEscalations && (
          <button type="button" onClick={onOpenEscalations} className="text-xs text-royal hover:text-blue-700">
            View all
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-gray-500">Loading...</p>}
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && escalations.length === 0 && (
        <p className="text-sm text-gray-500">No escalations.</p>
      )}

      <ul className="divide-y divide-gray-100">
        {escalations.map((e) => (
          <li key={e.escalation_id} className="py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <UrgencyBadge urgency={e.urgency} />
              <StatusBadge status={e.status} />
              {clientId === undefined && (
                <span className="text-sm text-gray-900">{e.client_username ?? `Client ${e.client_id}`}</span>
              )}
              <span className="text-xs text-gray-400 ml-auto">{new Date(e.created_at).toLocaleDateString()}</span>
            </div>
            <p className="mt-0.5 text-sm text-gray-700 line-clamp-1">{e.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
