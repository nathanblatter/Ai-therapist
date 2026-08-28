import { Users, AlertTriangle, ArrowUpRight, Activity, RefreshCw } from 'react-feather';
import Panel from './ui/Panel';
import StatCard from './ui/StatCard';
import ClientStatusRow, { type RosterClient } from './ClientStatusRow';
import useAdminFetch from '../hooks/useAdminFetch';

// Triage dashboard (caseworker portal): attention-ranked roster of the
// member's assigned clients, built entirely from the summaries-tier roster
// endpoint. Care-team members get their own roster; researchers get an
// org overview grouped per care-team member.

interface MemberRoster {
  member_id: number;
  username: string;
  member_role: string;
  clients: RosterClient[];
}

interface RosterResponse {
  clients?: RosterClient[];
  members?: MemberRoster[];
  generated_at: string;
}

interface CaseworkerDashboardProps {
  onSelectClient?: (clientId: number) => void;
}

function RosterTable({ clients, onSelectClient }: { clients: RosterClient[]; onSelectClient?: (id: number) => void }) {
  if (clients.length === 0) {
    return (
      <div className="py-10 text-center text-gray-500">
        <Users size={28} className="mx-auto mb-2" />
        <p className="text-sm">No clients assigned yet.</p>
      </div>
    );
  }
  return (
    <div>
      {clients.map((client) => (
        <ClientStatusRow key={client.client_id} client={client} onSelect={onSelectClient} />
      ))}
    </div>
  );
}

export default function CaseworkerDashboard({ onSelectClient }: CaseworkerDashboardProps) {
  const { data, loading, error, refetch } = useAdminFetch<RosterResponse>('/admin/api/caseworker/roster');

  const allClients: RosterClient[] =
    data?.clients ?? data?.members?.flatMap((m) => m.clients) ?? [];
  const needsAttention = allClients.filter((c) => c.attention.score >= 50).length;
  const openCrisis = allClients.reduce((sum, c) => sum + c.open_crisis_count, 0);
  const openEscalations = allClients.reduce((sum, c) => sum + c.open_escalation_count, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold text-ink">Triage</h2>
        <button
          onClick={refetch}
          className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Clients" value={allClients.length} icon={Users} />
        <StatCard label="Needs attention" value={needsAttention} icon={Activity} />
        <StatCard label="Open crisis flags" value={openCrisis} icon={AlertTriangle} />
        <StatCard label="Open escalations" value={openEscalations} icon={ArrowUpRight} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <Panel>
          <p className="text-sm text-gray-500 py-6 text-center">Loading roster…</p>
        </Panel>
      ) : data?.members ? (
        data.members.map((member) => (
          <Panel key={member.member_id} title={`${member.username} (${member.member_role})`} icon={Users}>
            <RosterTable clients={member.clients} onSelectClient={onSelectClient} />
          </Panel>
        ))
      ) : (
        <Panel title="Caseload" icon={Users}>
          <RosterTable clients={data?.clients ?? []} onSelectClient={onSelectClient} />
        </Panel>
      )}
    </div>
  );
}
