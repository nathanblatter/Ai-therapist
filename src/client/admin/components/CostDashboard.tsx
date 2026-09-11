// OpenAI cost dashboard (ai-therapist-181).
//
// Two kinds of number live here and they are deliberately never blended:
//   FACT      - dollars from OpenAI's costs API.
//   ESTIMATE  - those same dollars apportioned to product subsystems using our
//               own token counts. Flagged in the UI wherever it appears.
//
// Colour: subsystem hues come from the validated categorical palette and are
// assigned by the server's fixed SUBSYSTEMS order, so a subsystem keeps its
// hue across every chart (colour follows the entity, never its rank). Two
// light-mode slots sit under 3:1 on the surface, so the palette's relief rule
// applies: every bar carries a visible direct label and a table view exists.
// The admin app is light-only (no dark-mode classes anywhere), so this matches
// it rather than introducing a lone dark-capable panel.
import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList,
} from "recharts";
import { AlertTriangle, CheckCircle, Info, Table as TableIcon, BarChart2 } from "react-feather";
import useAdminFetch from "../hooks/useAdminFetch";

// --- validated palette (light surface #fcfcfb) --------------------------------
// node scripts/validate_palette.js "#2a78d6,#1baf7a,#eda100,#008300,#4a3aa7" --mode light
//   PASS band / PASS chroma / PASS CVD (worst adjacent 24.2) / WARN contrast -> relief shipped
const SUBSYSTEM_COLOR: Record<string, string> = {
  redaction: "#2a78d6",
  chat:      "#1baf7a",
  realtime:  "#eda100",
  crisis:    "#008300",
  insights:  "#4a3aa7",
  other:     "#8a8a85",
};
const SEQ = "#2a78d6";            // single-hue for one-measure charts
const STATUS = { ok: "#0ca30c", warning: "#fab219", critical: "#d03b3b" };
const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#8a8a85", grid: "#e8e8e4" };

interface Dashboard {
  configured: boolean;
  days: number;
  totalUsd: number;
  daily: Array<{ date: string; amountUsd: number }>;
  byLineItem: Array<{ lineItem: string; amountUsd: number }>;
  bySubsystem: Array<{ subsystem: string; amountUsd: number; share: number; estimated: boolean }>;
  attributionCaveats: string[];
  volume: {
    sessions: number; endedSessions: number; realtimeSessions: number;
    chatSessions: number; activeDays: number; participants: number;
  };
  unit: { usdPerSession: number | null; usdPerEndedSession: number | null; usdPerDay: number };
  budget: {
    monthlyCapUsd: number; monthToDateUsd: number;
    projectedMonthUsd: number; capRisk: "ok" | "warning" | "critical";
  };
  fetchedAt: string;
}

const usd = (n: number, dp = 2) => `$${n.toFixed(dp)}`;
// recharts 3.x types formatter args loosely (number | undefined / RenderableText),
// so coerce at the boundary rather than fighting the generics.
const usdLabel = (v: unknown) => usd(Number(v) || 0);
const usdLabel3 = (v: unknown) => usd(Number(v) || 0, 2);
const shortDate = (iso: string) => iso.slice(5).replace("-", "/");

function Panel({ title, subtitle, children, right }: {
  title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <div className="flex items-start justify-between mb-1">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        {right}
      </div>
      {subtitle && <p className="text-sm text-gray-600 mb-4">{subtitle}</p>}
      {children}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

/** Budget meter. A HARD cap 429s every OpenAI call — crisis detection included
 *  — so this is framed as a safety signal, not a billing note. */
function BudgetMeter({ budget }: { budget: Dashboard["budget"] }) {
  const pct = Math.min(100, (budget.monthToDateUsd / budget.monthlyCapUsd) * 100);
  const projPct = Math.min(100, (budget.projectedMonthUsd / budget.monthlyCapUsd) * 100);
  const color = STATUS[budget.capRisk];
  const Icon = budget.capRisk === "ok" ? CheckCircle : AlertTriangle;
  const message = budget.capRisk === "ok"
    ? "On track. Spend is well inside the monthly cap."
    : budget.capRisk === "warning"
      ? "Projected to approach the cap this month."
      : "At or near the cap. Hitting it returns 429 on EVERY call, including crisis detection.";

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <span className="text-3xl font-semibold text-gray-900 tabular-nums">
            {usd(budget.monthToDateUsd)}
          </span>
          <span className="text-sm text-gray-500 ml-2">
            of {usd(budget.monthlyCapUsd)} cap · month to date
          </span>
        </div>
        <span className="text-sm text-gray-600 tabular-nums">
          projected {usd(budget.projectedMonthUsd)}
        </span>
      </div>

      {/* Track: filled = actual, hollow marker = straight-line projection. */}
      <div className="relative w-full bg-gray-100 rounded h-5 overflow-hidden">
        <div className="h-5 rounded-l" style={{ width: `${pct}%`, backgroundColor: color }} />
        <div
          className="absolute top-0 h-5 border-l-2 border-dashed"
          style={{ left: `${projPct}%`, borderColor: INK.secondary }}
          aria-hidden="true"
        />
      </div>
      <div className="flex items-start gap-2 mt-3">
        <Icon size={16} style={{ color }} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-sm text-gray-700">
          <span className="font-medium" style={{ color }}>
            {budget.capRisk === "ok" ? "Within budget" : budget.capRisk === "warning" ? "Approaching cap" : "Cap risk"}
          </span>{" "}
          — {message} Dashed marker is the straight-line projection for the full month.
        </p>
      </div>
    </div>
  );
}

export default function CostDashboard() {
  const [days, setDays] = useState(30);
  const [view, setView] = useState<"chart" | "table">("chart");
  const { data, loading, error } = useAdminFetch<Dashboard>(
    `/admin/api/analytics/cost-dashboard?days=${days}`
  );

  if (loading) {
    return <Panel title="OpenAI Spend"><p className="text-gray-500 py-4">Loading cost data…</p></Panel>;
  }
  if (error || !data) {
    return <Panel title="OpenAI Spend"><p className="text-red-600 py-4">{error || "No cost data available"}</p></Panel>;
  }
  if (!data.configured) {
    return (
      <Panel title="OpenAI Spend">
        <p className="text-sm text-gray-600">
          Not configured. Set <code className="bg-gray-100 px-1 rounded">OPENAI_ADMIN_KEY</code> to an
          OpenAI <em>admin</em> key (Settings → Organization → Admin keys, Read only) to show real spend.
          Admin keys cannot make model calls and this one is only ever read server-side.
        </p>
      </Panel>
    );
  }

  const subsystemData = data.bySubsystem.map(s => ({
    ...s, label: s.subsystem, fill: SUBSYSTEM_COLOR[s.subsystem] ?? SUBSYSTEM_COLOR.other,
  }));
  const lineItemData = data.byLineItem.slice(0, 10);
  const anyEstimated = data.bySubsystem.some(s => s.estimated);

  return (
    <div>
      {/* --- range filter, one row above the charts --- */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1" role="group" aria-label="Time range">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-sm rounded border ${
                days === d ? "bg-royal text-white border-royal" : "bg-white text-gray-700 border-gray-300 hover:border-gray-400"
              }`}
              aria-pressed={days === d}
            >
              {d}d
            </button>
          ))}
        </div>
        <button
          onClick={() => setView(v => (v === "chart" ? "table" : "chart"))}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:border-gray-400"
        >
          {view === "chart" ? <TableIcon size={14} /> : <BarChart2 size={14} />}
          {view === "chart" ? "Table view" : "Chart view"}
        </button>
      </div>

      <Panel
        title="Budget"
        subtitle="A hard spend cap returns 429 on every OpenAI call, so this doubles as a safety indicator."
      >
        <BudgetMeter budget={data.budget} />
      </Panel>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label={`Spend (${data.days}d)`} value={usd(data.totalUsd)} hint="real, from OpenAI billing" />
        <Stat label="Per day" value={usd(data.unit.usdPerDay)} hint={`over ${data.daily.length} days`} />
        <Stat
          label="Per session"
          value={data.unit.usdPerSession === null ? "—" : usd(data.unit.usdPerSession, 3)}
          hint={`${data.volume.sessions} sessions`}
        />
        <Stat
          label="Participants"
          value={String(data.volume.participants)}
          hint={`${data.volume.realtimeSessions} voice · ${data.volume.chatSessions} chat`}
        />
      </div>

      {view === "table" ? (
        <Panel title="All figures" subtitle="Table view of every chart on this page.">
          <table className="w-full text-sm mb-6">
            <caption className="text-left text-xs uppercase tracking-wide text-gray-500 mb-2">
              Spend by subsystem (estimated apportionment)
            </caption>
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-1 font-medium">Subsystem</th>
                <th className="py-1 font-medium text-right">Cost</th>
                <th className="py-1 font-medium text-right">Share</th>
                <th className="py-1 font-medium text-right">Basis</th>
              </tr>
            </thead>
            <tbody>
              {data.bySubsystem.map(s => (
                <tr key={s.subsystem} className="border-b last:border-0">
                  <td className="py-1 text-gray-700">{s.subsystem}</td>
                  <td className="py-1 text-right tabular-nums">{usd(s.amountUsd)}</td>
                  <td className="py-1 text-right tabular-nums text-gray-600">{(s.share * 100).toFixed(0)}%</td>
                  <td className="py-1 text-right text-gray-500">{s.estimated ? "estimated" : "measured"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="w-full text-sm mb-6">
            <caption className="text-left text-xs uppercase tracking-wide text-gray-500 mb-2">
              Spend by line item (authoritative)
            </caption>
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-1 font-medium">Line item</th>
                <th className="py-1 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byLineItem.map(i => (
                <tr key={i.lineItem} className="border-b last:border-0">
                  <td className="py-1 text-gray-700">{i.lineItem}</td>
                  <td className="py-1 text-right tabular-nums">{usd(i.amountUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="w-full text-sm">
            <caption className="text-left text-xs uppercase tracking-wide text-gray-500 mb-2">
              Daily spend
            </caption>
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-1 font-medium">Date</th>
                <th className="py-1 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map(d => (
                <tr key={d.date} className="border-b last:border-0">
                  <td className="py-1 text-gray-700">{d.date}</td>
                  <td className="py-1 text-right tabular-nums">{usd(d.amountUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : (
        <>
          <Panel title={`Daily spend (last ${data.days} days)`}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={INK.grid} vertical={false} />
                <XAxis
                  dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: INK.secondary }}
                  axisLine={{ stroke: INK.grid }} tickLine={false} interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 11, fill: INK.secondary }}
                  axisLine={false} tickLine={false} width={48}
                />
                <Tooltip
                  cursor={{ fill: "rgba(0,0,0,0.04)" }}
                  formatter={(v: unknown) => [usd(Number(v) || 0), "Spend"]}
                  labelFormatter={(l: string) => l}
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${INK.grid}` }}
                />
                <Bar dataKey="amountUsd" fill={SEQ} radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          <Panel
            title="Where the money goes"
            subtitle="Real dollars apportioned to product subsystems using our own token counts — an estimate, not a billing statement."
          >
            <ResponsiveContainer width="100%" height={Math.max(160, subsystemData.length * 46)}>
              <BarChart
                data={subsystemData} layout="vertical"
                margin={{ top: 4, right: 72, left: 8, bottom: 4 }}
              >
                <CartesianGrid stroke={INK.grid} horizontal={false} />
                <XAxis type="number" tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 11, fill: INK.secondary }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category" dataKey="label" width={86}
                  tick={{ fontSize: 12, fill: INK.primary }} axisLine={false} tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(0,0,0,0.04)" }}
                  formatter={(v: unknown, _n: unknown, p: { payload?: { share?: number; estimated?: boolean } }) => [
                    `${usd(Number(v) || 0)} (${((p?.payload?.share ?? 0) * 100).toFixed(0)}%)`,
                    p?.payload?.estimated ? "Estimated" : "Measured",
                  ]}
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${INK.grid}` }}
                />
                <Bar dataKey="amountUsd" radius={[0, 4, 4, 0]} maxBarSize={26}>
                  {subsystemData.map(d => <Cell key={d.subsystem} fill={d.fill} />)}
                  {/* Direct labels: the palette's relief rule for sub-3:1 slots. */}
                  <LabelList
                    dataKey="amountUsd" position="right"
                    formatter={usdLabel}
                    style={{ fontSize: 12, fill: INK.primary }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {anyEstimated && (
              <div className="flex items-start gap-2 mt-3 text-xs text-gray-600">
                <Info size={14} className="flex-shrink-0 mt-0.5 text-gray-400" aria-hidden="true" />
                <p>
                  Subsystems sharing a model (crisis and insights both use gpt-4o-mini) are split by
                  measured token share.
                  {data.attributionCaveats.length > 0 && ` ${data.attributionCaveats.join("; ")}.`}
                </p>
              </div>
            )}
          </Panel>

          <Panel title="By line item" subtitle="Straight from OpenAI billing — authoritative.">
            <ResponsiveContainer width="100%" height={Math.max(160, lineItemData.length * 34)}>
              <BarChart data={lineItemData} layout="vertical" margin={{ top: 4, right: 72, left: 8, bottom: 4 }}>
                <CartesianGrid stroke={INK.grid} horizontal={false} />
                <XAxis type="number" tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 11, fill: INK.secondary }} axisLine={false} tickLine={false} />
                <YAxis
                  type="category" dataKey="lineItem" width={210}
                  tick={{ fontSize: 11, fill: INK.primary }} axisLine={false} tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(0,0,0,0.04)" }}
                  formatter={(v: unknown) => [usd(Number(v) || 0), "Cost"]}
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: `1px solid ${INK.grid}` }}
                />
                <Bar dataKey="amountUsd" fill={SEQ} radius={[0, 4, 4, 0]} maxBarSize={18}>
                  <LabelList dataKey="amountUsd" position="right" formatter={usdLabel3} style={{ fontSize: 11, fill: INK.primary }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        </>
      )}

      <p className="text-xs text-gray-500">
        Billing data lags on OpenAI's side, so the most recent day is provisional; figures are cached
        for 10 minutes. Fetched {new Date(data.fetchedAt).toLocaleString()}.
      </p>
    </div>
  );
}
