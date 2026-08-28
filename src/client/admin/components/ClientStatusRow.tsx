import { TrendingUp, TrendingDown, Minus, MessageSquare, Shield, ChevronRight } from 'react-feather';
import { timeAgo } from '../hooks/useWorkQueue';

// One triage-roster row (summaries tier by construction: everything shown
// here comes from the transcript-free dashboard endpoint).

export interface RosterAttentionReason {
  code: string;
  label: string;
  points: number;
}

export interface RosterClient {
  client_id: number;
  username: string;
  assigned_at: string;
  member_role: string;
  last_session_at: string | null;
  ended_session_count: number;
  last_checkin_mood: number | null;
  last_summary: unknown;
  last_summary_session_id: string | null;
  latest_risk_score: number | null;
  latest_risk_severity: string | null;
  latest_risk_at: string | null;
  open_crisis_count: number;
  latest_scales: Array<{ scale: string; score: number; created_at: string }> | null;
  open_escalation_count: number;
  overdue_practice_count: number;
  has_safety_plan: boolean;
  unread_count: number;
  attention: { score: number; reasons: RosterAttentionReason[] };
}

const RISK_CLASSES: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-green-100 text-green-800',
};

function riskTrendIcon(severity: string | null) {
  if (severity === 'high') return <TrendingUp size={14} className="text-red-600" />;
  if (severity === 'medium') return <TrendingUp size={14} className="text-amber-600" />;
  if (severity === 'low') return <TrendingDown size={14} className="text-green-600" />;
  return <Minus size={14} className="text-gray-400" />;
}

interface ClientStatusRowProps {
  client: RosterClient;
  onSelect?: (clientId: number) => void;
}

export default function ClientStatusRow({ client, onSelect }: ClientStatusRowProps) {
  const needsAttention = client.attention.score >= 50;
  return (
    <button
      onClick={onSelect ? () => onSelect(client.client_id) : undefined}
      disabled={!onSelect}
      className={`w-full text-left border-b border-gray-100 py-3 px-2 flex items-center gap-3 ${
        onSelect ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'
      }`}
    >
      <div
        className={`w-1.5 self-stretch rounded-full shrink-0 ${
          client.open_crisis_count > 0
            ? 'bg-red-500'
            : needsAttention
              ? 'bg-amber-400'
              : 'bg-gray-200'
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-ink">{client.username}</span>
          {client.latest_risk_severity && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${
                RISK_CLASSES[client.latest_risk_severity] ?? 'bg-gray-100 text-gray-700'
              }`}
            >
              {riskTrendIcon(client.latest_risk_severity)}
              risk {client.latest_risk_severity}
            </span>
          )}
          {client.has_safety_plan && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 flex items-center gap-1">
              <Shield size={12} />
              safety plan
            </span>
          )}
          {client.unread_count > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 flex items-center gap-1">
              <MessageSquare size={12} />
              {client.unread_count} unread
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-0.5">
          Last session {timeAgo(client.last_session_at)}
          {' '}&bull;{' '}
          {client.ended_session_count} session{client.ended_session_count === 1 ? '' : 's'}
          {client.last_checkin_mood !== null && (
            <>
              {' '}&bull; last mood {client.last_checkin_mood}
            </>
          )}
        </div>
        {client.attention.reasons.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mt-1.5">
            {client.attention.reasons.map((reason) => (
              <span
                key={reason.code}
                title={`+${reason.points}`}
                className={`text-xs px-2 py-0.5 rounded-full ${
                  reason.code === 'crisis_open'
                    ? 'bg-red-100 text-red-800'
                    : reason.points >= 50
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-gray-100 text-gray-700'
                }`}
              >
                {reason.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {client.attention.score > 0 && (
          <span className={`text-sm font-semibold ${needsAttention ? 'text-amber-700' : 'text-gray-500'}`}>
            {client.attention.score}
          </span>
        )}
        {onSelect && <ChevronRight size={16} className="text-gray-400" />}
      </div>
    </button>
  );
}
