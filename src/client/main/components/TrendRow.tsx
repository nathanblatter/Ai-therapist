// Lightweight inline-SVG trend marks for the participant client, shared by
// the between-sessions Home and the reflections card. Deliberately not
// Recharts: the participant bundle does not ship it (only the admin client
// does), and these tiny labeled small-multiples do not justify adding it.

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- sparkline (inline SVG, one labeled row per measure) ----------

export function Sparkline({ values, min, max }: { values: number[]; min: number; max: number }) {
  // Wide viewBox so the stretch factor under preserveAspectRatio="none" stays
  // near 1 at typical card widths (keeps the endpoint dot close to circular).
  const W = 300;
  const H = 36;
  const PAD = 6; // keeps the 2px stroke and endpoint dot inside the viewBox
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (values.length - 1));
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-9" aria-hidden="true" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke="#2563eb"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r="4" fill="#2563eb" stroke="#ffffff" strokeWidth="2" />
    </svg>
  );
}

/** One labeled trend row: name + sparkline + latest value (text stays in ink
 *  tokens; the mark alone carries the series). Values are oldest -> newest. */
export function TrendRow({
  label,
  values,
  min,
  max,
  latestLabel,
  dateRange,
}: {
  label: string;
  values: number[];
  min: number;
  max: number;
  latestLabel: string;
  dateRange: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 flex-shrink-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="text-xs text-gray-400">{dateRange}</p>
      </div>
      <div className="flex-1 min-w-0">
        <Sparkline values={values} min={min} max={max} />
      </div>
      <p className="w-14 flex-shrink-0 text-right text-sm text-gray-600 tabular-nums">{latestLabel}</p>
    </div>
  );
}
