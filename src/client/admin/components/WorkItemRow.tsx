import { useState } from 'react';
import {
  AlertTriangle,
  MessageSquare,
  FileText,
  ArrowUpRight,
  CornerDownLeft,
  Edit3,
  Clock,
  Activity,
  Mail,
  Check,
  CheckCircle,
} from 'react-feather';
import type { FC } from 'react';
import type { IconProps } from 'react-feather';
import { timeAgo, type AttentionWorkItem } from '../hooks/useWorkQueue';

// One work-queue row: type icon, severity badge, title, age, and the
// ack / resolve lifecycle actions (resolve expands an optional-note form).

const TYPE_ICONS: Record<string, FC<IconProps>> = {
  crisis_flag: AlertTriangle,
  message_crisis: MessageSquare,
  adverse_event: FileText,
  escalation_inbound: ArrowUpRight,
  escalation_response: CornerDownLeft,
  note_awaiting_signature: Edit3,
  inactivity: Clock,
  screener_worsening: Activity,
  message_unread_stale: Mail,
};

const TYPE_LABELS: Record<string, string> = {
  crisis_flag: 'Crisis flag',
  message_crisis: 'Flagged message',
  adverse_event: 'Adverse event',
  escalation_inbound: 'Escalation',
  escalation_response: 'Escalation update',
  note_awaiting_signature: 'Note to sign',
  inactivity: 'Inactivity',
  screener_worsening: 'Screener trend',
  message_unread_stale: 'Stale unread',
};

const SEVERITY_CLASSES: Record<string, string> = {
  urgent: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-800',
  info: 'bg-blue-100 text-blue-800',
};

interface WorkItemRowProps {
  item: AttentionWorkItem;
  onAck: (itemId: number) => Promise<boolean> | void;
  onResolve: (itemId: number, note?: string) => Promise<boolean> | void;
  onSelectClient?: (clientId: number) => void;
}

export default function WorkItemRow({ item, onAck, onResolve, onSelectClient }: WorkItemRowProps) {
  const [showResolve, setShowResolve] = useState(false);
  const [note, setNote] = useState('');
  const Icon = TYPE_ICONS[item.item_type] ?? FileText;
  const closed = item.status === 'resolved' || item.status === 'expired';

  const submitResolve = async () => {
    const ok = await onResolve(item.item_id, note.trim() || undefined);
    if (ok !== false) {
      setShowResolve(false);
      setNote('');
    }
  };

  return (
    <div className={`border-b border-gray-100 py-3 px-1 ${closed ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-full shrink-0 ${SEVERITY_CLASSES[item.severity] ?? SEVERITY_CLASSES.info}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-ink truncate">{item.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${SEVERITY_CLASSES[item.severity] ?? SEVERITY_CLASSES.info}`}>
              {item.severity}
            </span>
            {item.is_sandbox && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">sandbox</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{TYPE_LABELS[item.item_type] ?? item.item_type}</span>
            <span aria-hidden="true">&bull;</span>
            <span>{timeAgo(item.created_at)}</span>
            {item.status === 'acked' && (
              <>
                <span aria-hidden="true">&bull;</span>
                <span>acknowledged {timeAgo(item.acked_at)}</span>
              </>
            )}
            {item.status === 'resolved' && (
              <>
                <span aria-hidden="true">&bull;</span>
                <span>resolved {timeAgo(item.resolved_at)}</span>
              </>
            )}
            {item.client_id !== null && onSelectClient && (
              <button
                onClick={() => onSelectClient(item.client_id!)}
                className="text-royal hover:underline"
              >
                View client
              </button>
            )}
          </div>
          {item.resolution_note && (
            <p className="text-xs text-gray-600 mt-1">Resolution: {item.resolution_note}</p>
          )}
          {showResolve && !closed && (
            <div className="mt-2 flex items-start gap-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Resolution note (optional)"
                rows={2}
                className="flex-1 border border-gray-300 rounded-lg p-2 text-sm"
              />
              <button
                onClick={submitResolve}
                className="bg-navy text-white px-3 py-1.5 rounded-lg text-sm font-semibold"
              >
                Resolve
              </button>
              <button
                onClick={() => setShowResolve(false)}
                className="text-gray-500 px-2 py-1.5 text-sm"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {!closed && !showResolve && (
          <div className="flex items-center gap-1 shrink-0">
            {item.status === 'open' && (
              <button
                onClick={() => onAck(item.item_id)}
                className="flex items-center gap-1 text-sm px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50"
                title="Acknowledge"
              >
                <Check size={14} />
                <span className="hidden sm:inline">Ack</span>
              </button>
            )}
            <button
              onClick={() => setShowResolve(true)}
              className="flex items-center gap-1 text-sm px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50"
              title="Resolve"
            >
              <CheckCircle size={14} />
              <span className="hidden sm:inline">Resolve</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
