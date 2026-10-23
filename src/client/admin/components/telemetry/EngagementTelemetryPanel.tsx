// Phase 2 engagement telemetry (ai-therapist-205): per-kind counts from
// engagement_events and the session-rhythm habit metrics (migration 095).
// Reads /admin/api/telemetry/engagement (researcher-only). The event stream
// is IRB-gated and OFF until Phase 2 is approved; the panel says so rather
// than showing an empty chart.
import { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity, Clock, Users, Calendar, ToggleLeft } from 'react-feather';
import useAdminFetch from '../../hooks/useAdminFetch';
import Panel from '../ui/Panel';
import StatCard from '../ui/StatCard';
import { formatSeconds, SERIES_PRIMARY, GRID_STROKE, AXIS_TICK } from './telemetryFormat';

interface KindStat {
  kind: string;
  count: number;
  last_seen: string;
}
interface Rhythm {
  sessions: number;
  participants: number;
  p50_duration_seconds: number | null;
  p50_gap_seconds: number | null;
  start_hours: Array<{ start_hour: number; sessions: number }>;
}
interface EngagementData {
  days: number;
  flags: Record<string, boolean>;
  kinds: KindStat[];
  rhythm: Rhythm;
}

const FLAG_LABELS: Record<string, string> = {
  telemetry_interaction_timing: 'Interaction timing (turn_timing)',
  telemetry_engagement_events: 'Engagement events (visibility, scroll-back, tool opens, check-in skips)',
};

const WINDOWS = [7, 30, 90] as const;

function hourLabel(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

export default function EngagementTelemetryPanel() {
  const [days, setDays] = useState<number>(30);
  const { data, loading, error } = useAdminFetch<EngagementData>(`/admin/api/telemetry/engagement?days=${days}`);

  if (loading) {
    return (
      <Panel>
        <p className="text-gray-500 text-center py-4">Loading engagement telemetry...</p>
      </Panel>
    );
  }
  if (error || !data) {
    return (
      <Panel>
        <p className="text-red-600 text-center py-4">{error || 'No engagement telemetry available'}</p>
      </Panel>
    );
  }

  const anyFlagOn = Object.values(data.flags).some(Boolean);
  const offFlags = Object.entries(data.flags)
    .filter(([, on]) => !on)
    .map(([flag]) => flag);
  const hourData = Array.from({ length: 24 }, (_, h) => ({
    hour: hourLabel(h),
    sessions: data.rhythm.start_hours.find((s) => s.start_hour === h)?.sessions ?? 0,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-xl font-bold flex items-center gap-2">
            <Activity size={20} /> Engagement
          </h3>
          <p className="text-sm text-gray-600">
            Phase 2 engagement stream and session-rhythm habit metrics, last {data.days} days.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              aria-pressed={days === w}
              className={`px-3 py-1 text-sm rounded border ${days === w ? 'bg-royal text-white border-royal' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      <Panel title="Engagement Events" icon={ToggleLeft}>
        {!anyFlagOn && data.kinds.length === 0 ? (
          <div className="text-sm text-gray-700 space-y-2">
            <p className="font-medium text-gray-900">Telemetry is off.</p>
            <p>
              The engagement stream is gated by the Phase 2 IRB protocol and nothing is being collected. Turn it on in
              System Config under Phase 2 Research Telemetry once the protocol authorizes it:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              {offFlags.map((flag) => (
                <li key={flag}>
                  <code className="bg-gray-100 px-1 rounded text-xs">features.{flag}</code>
                  <span className="text-gray-600"> - {FLAG_LABELS[flag] ?? flag}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {offFlags.length > 0 && (
              <p className="text-sm text-gray-600 mb-3">
                Partially enabled. Off:{' '}
                {offFlags.map((f) => (
                  <code key={f} className="bg-gray-100 px-1 rounded text-xs mr-1">
                    features.{f}
                  </code>
                ))}
              </p>
            )}
            {data.kinds.length === 0 ? (
              <p className="text-gray-500 text-sm py-2">Enabled, but no events have arrived in this window yet.</p>
            ) : (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-600 border-b">
                    <th className="py-2 pr-4">Kind</th>
                    <th className="py-2 pr-4 text-right">Count</th>
                    <th className="py-2 pr-4">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.kinds.map((k) => (
                    <tr key={k.kind} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{k.kind}</td>
                      <td className="py-2 pr-4 text-right">{k.count}</td>
                      <td className="py-2 pr-4">{k.last_seen ? new Date(k.last_seen).toLocaleString() : 'N/A'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Panel>

      <div>
        <h4 className="text-base font-semibold text-gray-900 mb-1">Session rhythm</h4>
        <p className="text-sm text-gray-600 mb-3">
          Derived from session timestamps the study already collects (participant_session_rhythm), so it is not
          flag-gated.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatCard label="Sessions" value={data.rhythm.sessions} icon={Activity} />
          <StatCard label="Participants" value={data.rhythm.participants} icon={Users} />
          <StatCard
            label="Median duration"
            value={formatSeconds(data.rhythm.p50_duration_seconds)}
            sub="start to end"
            icon={Clock}
          />
          <StatCard
            label="Median gap"
            value={formatSeconds(data.rhythm.p50_gap_seconds)}
            sub="between a participant's sessions"
            icon={Calendar}
          />
        </div>
      </div>

      <Panel title="Sessions by Start Hour">
        {data.rhythm.sessions === 0 ? (
          <p className="text-gray-500 text-sm py-2">No sessions in this window.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hourData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} barCategoryGap={4}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="hour" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={2} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
              <Tooltip cursor={{ fill: '#F3F4F6' }} formatter={(v) => [String(v), 'Sessions']} />
              <Bar dataKey="sessions" name="Sessions" fill={SERIES_PRIMARY} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>
    </div>
  );
}
