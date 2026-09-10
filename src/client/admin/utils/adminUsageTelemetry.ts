// De-identified admin usage telemetry (migration 096). Batched
// fire-and-forget reports of admin-app usage patterns — which views get
// opened, how long they stay visible, overlay opens, client/API errors.
//
// De-identification contract (mirrored by the schema and the ingest route):
// - usageSessionId is a random uuid minted per TAB LOAD. It sequences a
//   single sitting but cannot join sittings into a per-person history.
// - No user id, username, IP, or user agent is ever sent or stored; the
//   server attaches only the coarse role cohort from the session.
// - Details carry view/overlay NAMES and templated API paths only — never a
//   participant, session, or user identifier. The server re-scrubs anyway.
//
// Operational constraints (mirrors the participant telemetry modules):
// never throws, batched flushes with sendBeacon on page hide, capped per
// page load, server rate-limits as a backstop.

export type AdminUsageKind =
  | 'view_open'
  | 'view_heartbeat'
  | 'overlay_open'
  | 'js_error'
  | 'api_error';

const FLUSH_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const MAX_BATCH = 50;
const MAX_TOTAL = 1000;

const usageSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : null;

interface QueuedEvent {
  kind: AdminUsageKind;
  detail: Record<string, unknown> | null;
  seq: number;
}

let enabled = false;
let queue: QueuedEvent[] = [];
let seqCounter = 0;
let sentTotal = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let currentView: string | null = null;
let viewVisibleSince: number | null = null;

/** Apply the server-delivered flag (features.telemetry_admin_usage). */
export function configureAdminUsageTelemetry(isEnabled: boolean): void {
  enabled = isEnabled && usageSessionId !== null;
}

/** Queue one usage event. Safe to call from anywhere; never throws. */
export function recordAdminUsage(kind: AdminUsageKind, detail?: Record<string, unknown>): void {
  try {
    if (!enabled || sentTotal >= MAX_TOTAL) return;
    sentTotal += 1;
    queue.push({ kind, detail: detail ?? null, seq: seqCounter++ });
    if (!flushTimer && typeof setInterval === 'function') {
      flushTimer = setInterval(flush, FLUSH_MS);
    }
    if (queue.length >= MAX_BATCH) flush();
  } catch {
    // Telemetry must never break the app.
  }
}

/** Report the active view; emits view_open and closes out the previous
 *  view's visible time as a heartbeat. */
export function setAdminUsageView(view: string | null): void {
  try {
    emitVisibleTime();
    currentView = view;
    viewVisibleSince = view !== null && document.visibilityState === 'visible' ? performance.now() : null;
    if (view !== null) recordAdminUsage('view_open', { view });
  } catch {
    // Telemetry must never break the app.
  }
}

function emitVisibleTime(): void {
  if (currentView === null || viewVisibleSince === null) return;
  const visibleMs = performance.now() - viewVisibleSince;
  viewVisibleSince = null;
  if (visibleMs >= 1000) {
    recordAdminUsage('view_heartbeat', { view: currentView, visible_ms: Math.round(visibleMs) });
  }
}

function flush(useBeacon = false): void {
  try {
    if (queue.length === 0 || usageSessionId === null) return;
    const events = queue.slice(0, MAX_BATCH);
    queue = queue.slice(MAX_BATCH);
    const body = JSON.stringify({ usageSessionId, events });

    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // Blob with an explicit JSON type so express parses it.
      if (navigator.sendBeacon('/admin/api/usage-events', new Blob([body], { type: 'application/json' }))) return;
    }
    void fetch('/admin/api/usage-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'include',
    }).catch(() => { /* fire-and-forget */ });
  } catch {
    // Telemetry must never break the app.
  }
}

/** Numeric ids, uuids, and app id shapes become placeholders client-side
 *  too, so concrete resources never leave the browser. */
export function templateClientPath(path: string): string {
  return path
    .slice(0, 300)
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b(sess|chat|redteam)_\w+/g, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** Report a failed admin API call (templated path + status only). */
export function recordAdminApiError(path: string, status: number): void {
  recordAdminUsage('api_error', { path: templateClientPath(path), status });
}

const seenErrors = new Set<string>();
let installed = false;

/**
 * Register page-level listeners once, from the admin entry: error capture,
 * visibility-aware view timing, heartbeats, and flush on page hide.
 */
export function installAdminUsageTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const message = String(event.message || 'unknown error');
    if (seenErrors.has(message)) return;
    seenErrors.add(message);
    recordAdminUsage('js_error', {
      message: message.slice(0, 300),
      source: typeof event.filename === 'string' ? templateClientPath(event.filename) : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'unknown rejection');
    if (seenErrors.has(message)) return;
    seenErrors.add(message);
    recordAdminUsage('js_error', { message: message.slice(0, 300) });
  });

  // Pause/resume the visible-time clock with tab visibility so heartbeats
  // measure attention, not open tabs.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      emitVisibleTime();
    } else if (currentView !== null && viewVisibleSince === null) {
      viewVisibleSince = performance.now();
    }
  });

  // Periodic heartbeat so long sittings on one view still report time.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    emitVisibleTime();
    if (currentView !== null) viewVisibleSince = performance.now();
  }, HEARTBEAT_MS);

  window.addEventListener('pagehide', () => {
    emitVisibleTime();
    flush(true);
  });
}
