// Measured per-turn latency (ai-therapist-205), from the turn_latency table
// (migration 057): realtime vs chat p50/p95 time-to-first-audio/first-token
// and total turn time, within-session drift by turn position, and one
// session's turn series on demand. Rendered inside OpsPanel for researchers;
// reads /admin/api/telemetry/latency (researcher-only).
import { useState, type FormEvent } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Clock, Search } from "react-feather";
import useAdminFetch from "../../hooks/useAdminFetch";
import Panel from "../ui/Panel";
import { formatMs, SERIES_PRIMARY, SERIES_SECONDARY, GRID_STROKE, AXIS_TICK } from "./telemetryFormat";

type Channel = 'realtime' | 'chat';
interface ChannelRow {
  channel: Channel; turns: number;
  p50_ttfa_ms: number | null; p95_ttfa_ms: number | null;
  p50_total_ms: number | null; p95_total_ms: number | null;
}
interface DriftRow { channel: Channel; bucket: string; bucket_start: number; turns: number; p50_ttfa_ms: number | null; p50_total_ms: number | null }
interface TurnRow { turn_index: number | null; user_done_at: string; ttfa_ms: number | null; total_ms: number | null; channel: Channel }
interface LatencyData {
  days: number;
  channels: ChannelRow[];
  drift: DriftRow[];
  session: { sessionId: string; turns: TurnRow[] } | null;
}

const CHANNEL_LABEL: Record<Channel, string> = { realtime: 'Realtime (voice)', chat: 'Chat (text)' };
const CHANNEL_COLOR: Record<Channel, string> = { realtime: SERIES_PRIMARY, chat: SERIES_SECONDARY };
const BUCKET_ORDER = ['1-4', '5-9', '10-19', '20+'];
const WINDOWS = [7, 30, 90] as const;

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export default function TurnLatencyPanel() {
  const [days, setDays] = useState<number>(7);
  const [sessionInput, setSessionInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const query = `/admin/api/telemetry/latency?days=${days}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`;
  const { data, loading, error } = useAdminFetch<LatencyData>(query);

  const submitSession = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = sessionInput.trim();
    setSessionId(trimmed.length > 0 ? trimmed : null);
  };

  if (loading && !data) {
    return <Panel title="Turn Latency" icon={Clock}><p className="text-gray-500 text-sm py-2">Loading turn latency...</p></Panel>;
  }
  if (error || !data) {
    return <Panel title="Turn Latency" icon={Clock}><p className="text-red-600 text-sm py-2">{error || 'No turn latency available'}</p></Panel>;
  }

  const driftChannels = Array.from(new Set(data.drift.map(d => d.channel))) as Channel[];
  const driftData = BUCKET_ORDER
    .map(bucket => {
      const row: Record<string, number | string | null> = { bucket };
      for (const ch of driftChannels) {
        const hit = data.drift.find(d => d.channel === ch && d.bucket === bucket);
        row[`${ch}_ttfa`] = hit ? num(hit.p50_ttfa_ms) : null;
        row[`${ch}_total`] = hit ? num(hit.p50_total_ms) : null;
        row[`${ch}_turns`] = hit ? hit.turns : 0;
      }
      return row;
    })
    .filter(row => driftChannels.some(ch => row[`${ch}_turns`] !== 0));

  const sessionTurns = (data.session?.turns ?? []).map((t, i) => ({
    turn: t.turn_index ?? i + 1,
    ttfa: num(t.ttfa_ms),
    total: num(t.total_ms),
    channel: t.channel,
  }));

  return (
    <Panel title="Turn Latency" icon={Clock}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-sm text-gray-600">
          Ground-truth per-turn timing from the sideband and chat loop over the last {data.days} days.
          Realtime TTFA is user turn end to first audio; chat is non-streaming, so first token equals total.
        </p>
        <div className="flex gap-1" role="group" aria-label="Window">
          {WINDOWS.map(w => (
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

      {data.channels.length === 0 ? (
        <p className="text-gray-500 text-sm py-2">No measured turns in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 pr-4">Channel</th>
                <th className="py-2 pr-4 text-right">Turns</th>
                <th className="py-2 pr-4 text-right">First output p50</th>
                <th className="py-2 pr-4 text-right">First output p95</th>
                <th className="py-2 pr-4 text-right">Total p50</th>
                <th className="py-2 pr-4 text-right">Total p95</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map(c => (
                <tr key={c.channel} className="border-b last:border-0">
                  <td className="py-2 pr-4 flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHANNEL_COLOR[c.channel] }} aria-hidden="true" />
                    {CHANNEL_LABEL[c.channel] ?? c.channel}
                  </td>
                  <td className="py-2 pr-4 text-right">{c.turns}</td>
                  <td className="py-2 pr-4 text-right">{formatMs(c.p50_ttfa_ms)}</td>
                  <td className="py-2 pr-4 text-right">{formatMs(c.p95_ttfa_ms)}</td>
                  <td className="py-2 pr-4 text-right">{formatMs(c.p50_total_ms)}</td>
                  <td className="py-2 pr-4 text-right">{formatMs(c.p95_total_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className="text-sm font-semibold text-gray-800 mt-5 mb-1">Within-session drift</h4>
      <p className="text-xs text-gray-500 mb-2">
        Median total turn time by position in the session. A rising line means later turns get slower
        (growing context); a flat one means latency is stable across a session.
      </p>
      {driftData.length === 0 ? (
        <p className="text-gray-500 text-sm py-2">Not enough indexed turns to show drift.</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={driftData} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="bucket" tick={AXIS_TICK} axisLine={false} tickLine={false} label={{ value: 'Turn position', position: 'insideBottomRight', offset: -4, fill: '#6B7280', fontSize: 11 }} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} tickFormatter={(v: number) => formatMs(v)} />
            <Tooltip
              formatter={(v, name) => [formatMs(typeof v === 'number' ? v : null), String(name)]}
              labelFormatter={(label) => `Turns ${String(label)}`}
            />
            {driftChannels.length > 1 && <Legend />}
            {driftChannels.map(ch => (
              <Line
                key={ch}
                type="monotone"
                dataKey={`${ch}_total`}
                name={`${CHANNEL_LABEL[ch]} total p50`}
                stroke={CHANNEL_COLOR[ch]}
                strokeWidth={2}
                dot={{ r: 4, strokeWidth: 2, fill: '#fff' }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      <h4 className="text-sm font-semibold text-gray-800 mt-5 mb-1">One session</h4>
      <form onSubmit={submitSession} className="flex gap-2 items-center mb-2">
        <label htmlFor="latency-session-id" className="sr-only">Session id</label>
        <input
          id="latency-session-id"
          type="text"
          value={sessionInput}
          onChange={e => setSessionInput(e.target.value)}
          placeholder="sess_... session id"
          className="border rounded px-3 py-1.5 text-sm font-mono flex-1 max-w-md"
        />
        <button type="submit" className="px-3 py-1.5 text-sm rounded bg-royal text-white hover:bg-navy flex items-center gap-1.5">
          <Search size={14} aria-hidden="true" /> Show turns
        </button>
      </form>
      {data.session && (
        sessionTurns.length === 0 ? (
          <p className="text-gray-500 text-sm py-2">No measured turns for {data.session.sessionId}.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={sessionTurns} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="turn" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} tickFormatter={(v: number) => formatMs(v)} />
              <Tooltip
                formatter={(v, name) => [formatMs(typeof v === 'number' ? v : null), String(name)]}
                labelFormatter={(label) => `Turn ${String(label)}`}
              />
              <Legend />
              <Line type="monotone" dataKey="ttfa" name="First output" stroke={SERIES_SECONDARY} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="total" name="Total" stroke={SERIES_PRIMARY} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )
      )}
    </Panel>
  );
}
