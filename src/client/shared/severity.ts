// Shared severity/risk display vocabulary for admin + participant UIs.
// Before this module, risk colors and score thresholds were hardcoded
// divergently across ~8 components (medium was amber in some, yellow or
// orange in others; score bands were 70/40 in CrisisManagement but 75/50/25
// in RiskTimeline). Canonical rules:
//   - medium is ALWAYS amber
//   - score bands mirror the server's crisisDetection.service.ts mapping
//     (>= 75 high, >= 50 medium, >= 25 low, else none)

export type SeverityLevel = 'high' | 'medium' | 'low';
export type WorkItemSeverity = 'urgent' | 'warning' | 'info';

const SOFT_SEVERITY_CLASSES: Record<SeverityLevel, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-green-100 text-green-800',
};

const SOLID_SEVERITY_CLASSES: Record<SeverityLevel, string> = {
  high: 'bg-red-600 text-white',
  medium: 'bg-amber-500 text-amber-900',
  low: 'bg-green-500 text-green-900',
};

/**
 * Tone classes for a severity chip. Soft (default) is the pastel pill used in
 * rows/lists; `solid` is the saturated header treatment (SessionDetail), with
 * `pulseHigh` adding the animate-pulse high-crisis variant.
 * Unknown/absent severities fall back to gray.
 */
export function severityBadgeClass(
  level: string | null | undefined,
  opts?: { solid?: boolean; pulseHigh?: boolean }
): string {
  const map = opts?.solid ? SOLID_SEVERITY_CLASSES : SOFT_SEVERITY_CLASSES;
  const cls = map[(level ?? '') as SeverityLevel];
  if (!cls) return opts?.solid ? 'bg-gray-400 text-gray-900' : 'bg-gray-100 text-gray-600';
  if (level === 'high' && opts?.solid && opts?.pulseHigh) return `${cls} animate-pulse`;
  return cls;
}

const WORK_ITEM_SEVERITY_CLASSES: Record<WorkItemSeverity, string> = {
  urgent: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-800',
  info: 'bg-blue-100 text-blue-800',
};

/** Tone classes for a work-queue item severity (urgent/warning/info vocabulary). */
export function workItemSeverityClass(severity: string): string {
  return WORK_ITEM_SEVERITY_CLASSES[severity as WorkItemSeverity] ?? WORK_ITEM_SEVERITY_CLASSES.info;
}

/**
 * Canonical numeric risk score -> severity level, mirroring the server-side
 * bands in services/crisisDetection.service.ts (>= 75 high, >= 50 medium).
 * The server additionally treats < 25 as 'none'; UI text helpers render that
 * band muted via riskScoreTextClass.
 */
export function riskScoreLevel(score: number): SeverityLevel {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

/** Inline text tone for a numeric risk score (sub-25 'none' band renders muted). */
export function riskScoreTextClass(score: number): string {
  if (score >= 75) return 'text-red-600';
  if (score >= 50) return 'text-amber-600';
  if (score >= 25) return 'text-green-600';
  return 'text-gray-400';
}

/** Generic workflow-status tone (crisis follow-up reviews and the like). */
export function statusBadgeClass(status: string | undefined): string {
  switch (status?.toLowerCase()) {
    case 'completed': return 'bg-green-100 text-green-800';
    case 'in_progress': return 'bg-blue-100 text-blue-800';
    case 'pending': return 'bg-yellow-100 text-yellow-800';
    default: return 'bg-gray-100 text-gray-800';
  }
}
