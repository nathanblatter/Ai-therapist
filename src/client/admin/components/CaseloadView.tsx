import { useMemo, useState } from "react";
import {
  Users,
  UserPlus,
  UserMinus,
  UserCheck,
  Link as LinkIcon,
  Copy,
  Check,
  Clock,
  XCircle,
  Plus,
  AlertTriangle,
} from "react-feather";
import useAdminFetch from "../hooks/useAdminFetch";
import EscalationComposer from "./escalations/EscalationComposer";
import { isCareTeamRole } from "../../../shared/roles";
// Canonical caseload row shape lives in the server data layer (type-only
// import, erased at build time).
import type { CaseloadClient } from "../../../server/db/caseload.queries";

// Caseload view (caseload RBAC MVP, ai-therapist-119; caseworker portal).
// - Care-team mode (therapist OR caseworker): their own assigned-client list
//   plus the client invite panel (create invite link, copy it, see
//   pending/used/expired invites). Caseworkers additionally get a per-client
//   "Escalate" action (docs/caseworker-portal.md slice B).
// - Researcher mode: the assignment matrix — pick a therapist, then
//   assign/unassign participant clients via the caseload routes.

interface Assignment {
  therapist_id: number;
  therapist_username: string;
  client_id: number;
  client_username: string;
  assigned_at: string;
}

interface TherapistRow {
  userid: number;
  username: string;
}

interface InviteRow {
  invite_id: number;
  label: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: number | null;
  status?: string;
}

interface RosterUser {
  userid: number;
  username: string;
  role: string;
}

interface CaseloadViewProps {
  userRole: string | null;
}

// Admin route response envelopes vary ({ sessions }, { events }, raw arrays…);
// accept either a bare array or the first array-valued key among `keys`.
function pickArray<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    for (const key of keys) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

function inviteStatus(invite: InviteRow): "pending" | "used" | "expired" {
  if (invite.status === "used" || invite.status === "expired" || invite.status === "pending") {
    return invite.status;
  }
  if (invite.used_at) return "used";
  if (new Date(invite.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

function InviteStatusBadge({ status }: { status: "pending" | "used" | "expired" }) {
  if (status === "used") {
    return (
      <span className="px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
        <Check size={12} aria-hidden="true" />
        Used
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-500">
        <XCircle size={12} aria-hidden="true" />
        Expired
      </span>
    );
  }
  return (
    <span className="px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800">
      <Clock size={12} aria-hidden="true" />
      Pending
    </span>
  );
}

// ---------------------------------------------------------------------------
// Therapist mode
// ---------------------------------------------------------------------------

function TherapistCaseload({ userRole }: { userRole: string | null }) {
  const {
    data: caseloadData,
    loading: caseloadLoading,
    error: caseloadError,
  } = useAdminFetch<unknown>("/admin/api/caseload");
  const {
    data: invitesData,
    loading: invitesLoading,
    error: invitesError,
    refetch: refetchInvites,
  } = useAdminFetch<unknown>("/admin/api/caseload/invites");

  const [inviteLabel, setInviteLabel] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  // Per-client escalation composer target (caseworker portal slice B).
  const [escalateClient, setEscalateClient] = useState<CaseloadClient | null>(null);
  const isCaseworker = userRole === "caseworker";

  const clients = useMemo(
    () => pickArray<CaseloadClient>(caseloadData, ["caseload", "clients", "users"]),
    [caseloadData]
  );
  const invites = useMemo(
    () => pickArray<InviteRow>(invitesData, ["invites"]),
    [invitesData]
  );

  const toAbsoluteLink = (link: string): string =>
    link.startsWith("http") ? link : `${window.location.origin}${link}`;

  const handleCreateInvite = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setInviteError(null);
    setCreatedLink(null);
    setCopiedLink(false);
    setCreatingInvite(true);
    try {
      const response = await fetch("/admin/api/caseload/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ label: inviteLabel.trim() || null }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create invite");
      }
      const data = await response.json();
      const link: string | undefined = data.link ?? data.url ?? data.inviteUrl;
      if (link) {
        setCreatedLink(toAbsoluteLink(link));
      }
      setInviteLabel("");
      refetchInvites();
    } catch (err: unknown) {
      setInviteError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleCopyLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setInviteError("Could not copy to clipboard; copy the link manually.");
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">My Caseload</h2>
        <p className="text-gray-600 mt-1">
          {clients.length} assigned {clients.length === 1 ? "client" : "clients"}
        </p>
      </div>

      {caseloadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {caseloadError}
        </div>
      )}

      {/* Client list */}
      <div className="bg-white rounded-lg shadow overflow-hidden mb-8" role="region" aria-label="Assigned clients table">
        {caseloadLoading ? (
          <div className="text-center py-8 text-gray-500">Loading caseload...</div>
        ) : (
          <>
            <table className="min-w-full divide-y divide-gray-200" role="table">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    User ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Username
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Account Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Assigned
                  </th>
                  {isCaseworker && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {clients.map((client) => (
                  <tr key={client.userid} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{client.userid}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{client.username}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(client.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(client.assigned_at).toLocaleDateString()}
                    </td>
                    {isCaseworker && (
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <button
                          type="button"
                          onClick={() => setEscalateClient(client)}
                          className="text-amber-700 hover:text-amber-900 flex items-center gap-1 min-h-[36px]"
                          aria-label={`Escalate about ${client.username}`}
                        >
                          <AlertTriangle size={15} aria-hidden="true" />
                          Escalate
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {clients.length === 0 && (
              <div className="text-center py-8 text-gray-500">
                <Users size={48} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
                <p>No clients assigned yet. Create an invite link below to add a client.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Invite panel */}
      <div className="mb-6">
        <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <LinkIcon size={20} aria-hidden="true" />
          Client Invites
        </h3>
        <p className="text-gray-600 mt-1">
          Create a one-time link a new client can use to register. They are assigned to you automatically.
        </p>
      </div>

      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <form onSubmit={handleCreateInvite} className="flex gap-2 items-end flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="invite-label" className="block text-sm font-medium text-gray-700 mb-1">
              Label (optional, e.g. client initials)
            </label>
            <input
              id="invite-label"
              type="text"
              value={inviteLabel}
              onChange={(e) => setInviteLabel(e.target.value)}
              placeholder="e.g. J.D."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]"
            />
          </div>
          <button
            type="submit"
            disabled={creatingInvite}
            className="px-4 py-2 bg-royal text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 min-h-[44px]"
            aria-label="Create invite link"
          >
            <Plus size={16} aria-hidden="true" />
            {creatingInvite ? "Creating..." : "Create Invite"}
          </button>
        </form>

        {inviteError && (
          <div className="text-red-600 text-sm mt-3" role="alert">
            {inviteError}
          </div>
        )}

        {createdLink && (
          <div className="mt-4 bg-blue-50 border border-blue-200 rounded-md p-3">
            <p className="text-sm font-medium text-gray-700 mb-2">
              Invite link created. Copy it now — it is only shown once.
            </p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 text-sm bg-white border border-gray-200 rounded px-3 py-2 overflow-x-auto whitespace-nowrap">
                {createdLink}
              </code>
              <button
                type="button"
                onClick={handleCopyLink}
                className="px-3 py-2 bg-royal text-white rounded-md hover:bg-blue-700 flex items-center gap-1 whitespace-nowrap min-h-[44px]"
                aria-label="Copy invite link"
              >
                {copiedLink ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                {copiedLink ? "Copied" : "Copy Link"}
              </button>
            </div>
          </div>
        )}
      </div>

      {invitesError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {invitesError}
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden" role="region" aria-label="Invites table">
        {invitesLoading ? (
          <div className="text-center py-8 text-gray-500">Loading invites...</div>
        ) : (
          <>
            <table className="min-w-full divide-y divide-gray-200" role="table">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Label
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Expires
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider" scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {invites.map((invite) => (
                  <tr key={invite.invite_id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {invite.label || <span className="text-gray-400" aria-hidden="true">—</span>}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(invite.created_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(invite.expires_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <InviteStatusBadge status={inviteStatus(invite)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invites.length === 0 && (
              <div className="text-center py-8 text-gray-500">
                <LinkIcon size={48} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
                <p>No invites yet</p>
              </div>
            )}
          </>
        )}
      </div>

      {escalateClient && (
        <EscalationComposer
          clientId={escalateClient.userid}
          clientName={escalateClient.username}
          onClose={() => setEscalateClient(null)}
          onCreated={() => setEscalateClient(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Researcher mode
// ---------------------------------------------------------------------------

function ResearcherMatrix() {
  const {
    data: assignmentsData,
    loading: assignmentsLoading,
    error: assignmentsError,
    refetch: refetchAssignments,
  } = useAdminFetch<unknown>("/admin/api/caseload");
  const {
    data: therapistsData,
    loading: therapistsLoading,
    error: therapistsError,
  } = useAdminFetch<unknown>("/admin/api/caseload/therapists");
  // Full roster for the "available participants" column; researchers are
  // unscoped on /api/users.
  const {
    data: usersData,
    loading: usersLoading,
    error: usersError,
  } = useAdminFetch<unknown>("/api/users");

  const [selectedTherapistId, setSelectedTherapistId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingClientId, setPendingClientId] = useState<number | null>(null);

  const assignments = useMemo(
    () => pickArray<Assignment>(assignmentsData, ["assignments", "caseload"]),
    [assignmentsData]
  );
  const therapists = useMemo(
    () => pickArray<TherapistRow>(therapistsData, ["therapists", "users"]),
    [therapistsData]
  );
  const participants = useMemo(
    () => pickArray<RosterUser>(usersData, ["users"]).filter((u) => u.role === "participant"),
    [usersData]
  );

  const activeTherapistId = selectedTherapistId ?? therapists[0]?.userid ?? null;
  const activeTherapist = therapists.find((t) => t.userid === activeTherapistId) ?? null;

  const assignedToActive = useMemo(
    () => assignments.filter((a) => a.therapist_id === activeTherapistId),
    [assignments, activeTherapistId]
  );
  const assignedClientIds = useMemo(
    () => new Set(assignedToActive.map((a) => a.client_id)),
    [assignedToActive]
  );
  const availableParticipants = useMemo(
    () => participants.filter((p) => !assignedClientIds.has(p.userid)),
    [participants, assignedClientIds]
  );

  const caseloadCountByTherapist = useMemo(() => {
    const counts = new Map<number, number>();
    for (const a of assignments) {
      counts.set(a.therapist_id, (counts.get(a.therapist_id) ?? 0) + 1);
    }
    return counts;
  }, [assignments]);

  const mutateAssignment = async (method: "POST" | "DELETE", therapistId: number, clientId: number) => {
    setActionError(null);
    setPendingClientId(clientId);
    try {
      const response = await fetch(`/admin/api/caseload/${therapistId}/${clientId}`, {
        method,
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || (method === "POST" ? "Failed to assign client" : "Failed to unassign client"));
      }
      refetchAssignments();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingClientId(null);
    }
  };

  const loading = assignmentsLoading || therapistsLoading || usersLoading;
  const loadError = assignmentsError || therapistsError || usersError;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Caseload Assignments</h2>
        <p className="text-gray-600 mt-1">
          Assign participants to therapists. Therapists only see their assigned clients.
        </p>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-gray-500">Loading assignments...</p>
        </div>
      ) : therapists.length === 0 ? (
        <div className="bg-white rounded-lg shadow text-center py-8 text-gray-500">
          <UserCheck size={48} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
          <p>No therapist accounts exist yet. Create one in Users first.</p>
        </div>
      ) : (
        <>
          <div className="mb-6 max-w-md">
            <label htmlFor="therapist-picker" className="block text-sm font-medium text-gray-700 mb-1">
              Therapist
            </label>
            <select
              id="therapist-picker"
              value={activeTherapistId ?? ""}
              onChange={(e) => setSelectedTherapistId(Number(e.target.value))}
              aria-label="Select therapist"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-royal min-h-[44px]"
            >
              {therapists.map((t) => (
                <option key={t.userid} value={t.userid}>
                  {t.username} ({caseloadCountByTherapist.get(t.userid) ?? 0} clients)
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Assigned clients */}
            <div className="bg-white rounded-lg shadow overflow-hidden" role="region" aria-label="Assigned clients">
              <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-2">
                  <UserCheck size={16} aria-hidden="true" />
                  Assigned to {activeTherapist?.username ?? "therapist"} ({assignedToActive.length})
                </h3>
              </div>
              <ul className="divide-y divide-gray-200">
                {assignedToActive.map((a) => (
                  <li key={a.client_id} className="px-6 py-3 flex items-center justify-between hover:bg-gray-50">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{a.client_username}</p>
                      <p className="text-xs text-gray-500">
                        Assigned {new Date(a.assigned_at).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => activeTherapistId !== null && mutateAssignment("DELETE", activeTherapistId, a.client_id)}
                      disabled={pendingClientId === a.client_id}
                      className="text-red-600 hover:text-red-800 disabled:opacity-50 flex items-center gap-1 min-h-[44px]"
                      aria-label={`Unassign ${a.client_username} from ${activeTherapist?.username ?? "therapist"}`}
                    >
                      <UserMinus size={16} aria-hidden="true" />
                      Unassign
                    </button>
                  </li>
                ))}
              </ul>
              {assignedToActive.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Users size={40} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
                  <p className="text-sm">No clients assigned</p>
                </div>
              )}
            </div>

            {/* Available participants */}
            <div className="bg-white rounded-lg shadow overflow-hidden" role="region" aria-label="Available participants">
              <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-2">
                  <Users size={16} aria-hidden="true" />
                  Available Participants ({availableParticipants.length})
                </h3>
              </div>
              <ul className="divide-y divide-gray-200">
                {availableParticipants.map((p) => (
                  <li key={p.userid} className="px-6 py-3 flex items-center justify-between hover:bg-gray-50">
                    <p className="text-sm font-medium text-gray-900">{p.username}</p>
                    <button
                      type="button"
                      onClick={() => activeTherapistId !== null && mutateAssignment("POST", activeTherapistId, p.userid)}
                      disabled={pendingClientId === p.userid}
                      className="text-royal hover:text-blue-700 disabled:opacity-50 flex items-center gap-1 min-h-[44px]"
                      aria-label={`Assign ${p.username} to ${activeTherapist?.username ?? "therapist"}`}
                    >
                      <UserPlus size={16} aria-hidden="true" />
                      Assign
                    </button>
                  </li>
                ))}
              </ul>
              {availableParticipants.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Users size={40} className="mx-auto mb-2 text-gray-400" aria-hidden="true" />
                  <p className="text-sm">All participants are assigned to this therapist</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function CaseloadView({ userRole }: CaseloadViewProps) {
  if (userRole === "researcher") {
    return <ResearcherMatrix />;
  }
  if (isCareTeamRole(userRole)) {
    return <TherapistCaseload userRole={userRole} />;
  }
  return (
    <div className="flex items-center justify-center h-full p-8 text-gray-500">
      <p>Caseload is available to care-team and researcher accounts.</p>
    </div>
  );
}
