// Phase 2 engagement telemetry (flag-gated, default OFF). Batched
// fire-and-forget reports of interaction events declared in the Phase 2
// protocol: turn timing, visibility changes, scroll-back, tool overlay and
// check-in interactions. No conversation content ever rides these events.
//
// Design constraints (mirrors telemetry.ts):
// - Disabled until configureEngagementTelemetry() receives the server flags;
//   the server ALSO drops events for disabled streams, so this gate is UX
//   economy, not the enforcement point.
// - Never throws, never awaited by callers, never affects the session UX.
// - Batched: events queue and flush every few seconds via fetch keepalive,
//   with a sendBeacon flush on page hide; capped per page load so a loop
//   cannot flood the endpoint (the server rate-limits per IP as a backstop).

export type EngagementEventKind =
  | 'turn_timing'
  | 'visibility_change'
  | 'scroll_back'
  | 'tool_open'
  | 'tool_close'
  | 'tool_event'
  | 'checkin_complete'
  | 'checkin_skip'
  | 'checkin_dismissed';

const TIMING_KINDS = new Set<EngagementEventKind>(['turn_timing']);

const FLUSH_MS = 10_000;
const MAX_BATCH = 50;
const MAX_TOTAL = 500;

interface QueuedEvent {
  kind: EngagementEventKind;
  detail: Record<string, unknown> | null;
  sessionId: string | null;
}

let interactionTimingEnabled = false;
let engagementEventsEnabled = false;
let activeSessionId: string | null = null;
let queue: QueuedEvent[] = [];
let sentTotal = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Apply the server-delivered feature flags (both default off). */
export function configureEngagementTelemetry(flags: {
  interactionTiming?: boolean;
  engagementEvents?: boolean;
}): void {
  interactionTimingEnabled = flags.interactionTiming === true;
  engagementEventsEnabled = flags.engagementEvents === true;
}

/** Attach subsequent events to a session (null between sessions). */
export function setEngagementSessionId(sessionId: string | null): void {
  activeSessionId = sessionId;
  if (sessionId === null) flush();
}

function enabledFor(kind: EngagementEventKind): boolean {
  return TIMING_KINDS.has(kind) ? interactionTimingEnabled : engagementEventsEnabled;
}

/** Queue one engagement event. Safe to call from anywhere; never throws. */
export function recordEngagementEvent(
  kind: EngagementEventKind,
  detail?: Record<string, unknown>
): void {
  try {
    if (!enabledFor(kind) || sentTotal >= MAX_TOTAL) return;
    sentTotal += 1;
    queue.push({ kind, detail: detail ?? null, sessionId: activeSessionId });
    if (!flushTimer && typeof setInterval === 'function') {
      flushTimer = setInterval(flush, FLUSH_MS);
    }
    if (queue.length >= MAX_BATCH) flush();
  } catch {
    // Telemetry must never break the app.
  }
}

/** Record the participant's reply timing for one typed turn. */
export function recordTurnTiming(
  latencyMs: number | null,
  messageChars: number,
  modality: 'chat' | 'realtime_text'
): void {
  recordEngagementEvent('turn_timing', {
    latency_ms: latencyMs === null ? null : Math.round(latencyMs),
    message_chars: messageChars,
    modality,
  });
}

function flush(useBeacon = false): void {
  try {
    if (queue.length === 0) return;
    const events = queue.slice(0, MAX_BATCH);
    queue = queue.slice(MAX_BATCH);
    const body = JSON.stringify({ events });

    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // Blob with an explicit JSON type so express parses it.
      if (navigator.sendBeacon('/api/engagement-events', new Blob([body], { type: 'application/json' }))) return;
    }
    void fetch('/api/engagement-events', {
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

let installed = false;

/**
 * Register page-level listeners once, from the app entry: flush on page
 * hide, and record visibility changes while a session is active.
 */
export function installEngagementTracking(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  document.addEventListener('visibilitychange', () => {
    if (activeSessionId === null) return;
    recordEngagementEvent('visibility_change', { hidden: document.visibilityState === 'hidden' });
  });

  window.addEventListener('pagehide', () => flush(true));
  window.addEventListener('beforeunload', () => flush(true));
}
