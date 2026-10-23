// Shared formatting for the telemetry panels (ai-therapist-205).

export function formatMs(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return 'N/A';
  const n = typeof ms === 'number' ? ms : parseFloat(ms);
  if (!Number.isFinite(n)) return 'N/A';
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)}d`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

export function formatVisible(ms: number): string {
  return formatSeconds(ms / 1000);
}

// Chart colors: the admin brand blue for single-series marks, and a lighter
// blue for the second series where two channels are compared. The pair
// passes the dataviz palette validator (CVD and normal-vision separation).
export const SERIES_PRIMARY = '#0047BA';
export const SERIES_SECONDARY = '#5B8DEF';
export const GRID_STROKE = '#E5E7EB';
export const AXIS_TICK = { fill: '#6B7280', fontSize: 12 };
