import { useMemo, useState } from 'react';
import { Inbox, AlertTriangle, RefreshCw } from 'react-feather';
import Panel from './ui/Panel';
import StatCard from './ui/StatCard';
import WorkItemRow from './WorkItemRow';
import useWorkQueue from '../hooks/useWorkQueue';

// Care-team work queue view (caseworker portal). Presentation-only role
// prop: caseworkers land on the same queue as therapists; the server decides
// what each member can see (assignee + caseload pool).

type QueueTab = 'active' | 'resolved';

interface WorkQueueProps {
  role: 'caseworker' | 'therapist';
  onSelectClient?: (clientId: number) => void;
}

export default function WorkQueue({ role, onSelectClient }: WorkQueueProps) {
  const [tab, setTab] = useState<QueueTab>('active');
  const statuses = tab === 'active' ? ['open', 'acked'] : ['resolved', 'expired'];
  const { items, loading, error, actionError, refetch, ack, resolve } = useWorkQueue(statuses);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const openCount = items.filter((i) => i.status === 'open').length;
  const urgentCount = items.filter((i) => i.severity === 'urgent' && i.status !== 'resolved' && i.status !== 'expired').length;

  const types = useMemo(
    () => Array.from(new Set(items.map((i) => i.item_type))).sort(),
    [items]
  );
  const visible = typeFilter ? items.filter((i) => i.item_type === typeFilter) : items;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold text-ink">Work queue</h2>
        <button
          onClick={refetch}
          className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {tab === 'active' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatCard label="Open items" value={openCount} icon={Inbox} />
          <StatCard label="Urgent" value={urgentCount} icon={AlertTriangle} />
        </div>
      )}

      <Panel>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(['active', 'resolved'] as QueueTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                  tab === t ? 'bg-white shadow text-ink' : 'text-gray-600'
                }`}
              >
                {t === 'active' ? 'Active' : 'Resolved'}
              </button>
            ))}
          </div>
          {types.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              <button
                onClick={() => setTypeFilter(null)}
                className={`text-xs px-2.5 py-1 rounded-full border ${
                  typeFilter === null ? 'border-navy bg-lightBlue text-navy' : 'border-gray-300 text-gray-600'
                }`}
              >
                All
              </button>
              {types.map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                  className={`text-xs px-2.5 py-1 rounded-full border ${
                    typeFilter === t ? 'border-navy bg-lightBlue text-navy' : 'border-gray-300 text-gray-600'
                  }`}
                >
                  {t.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          )}
        </div>

        {actionError && <p className="text-sm text-red-600 mb-2">{actionError}</p>}
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        {loading ? (
          <p className="text-sm text-gray-500 py-6 text-center">Loading queue…</p>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center text-gray-500">
            <Inbox size={28} className="mx-auto mb-2" />
            <p className="text-sm">
              {tab === 'active'
                ? role === 'caseworker'
                  ? 'Nothing needs your attention right now.'
                  : 'Your queue is clear.'
                : 'No resolved items yet.'}
            </p>
          </div>
        ) : (
          <div>
            {visible.map((item) => (
              <WorkItemRow
                key={item.item_id}
                item={item}
                onAck={ack}
                onResolve={resolve}
                onSelectClient={onSelectClient}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
