// Client error beacon (pass-3 telemetry). Fire-and-forget reports of browser
// failures the server would otherwise never see (WebRTC negotiation, mic
// permission, data channel drops, chat send errors, uncaught JS errors).
//
// Design constraints:
// - Never throws, never awaited by callers, never affects the session UX.
// - Sampled/deduped: at most a few reports per kind per page load, with a
//   global cap, so an error loop cannot flood the endpoint (the server also
//   rate-limits per IP as a backstop).
// - navigator.sendBeacon when available (survives page unload), fetch with
//   keepalive as the fallback.

export type ClientEventKind =
  | 'js_error'
  | 'unhandled_rejection'
  | 'webrtc_failed'
  | 'webrtc_disconnected'
  | 'mic_permission_denied'
  | 'sdp_fetch_failed'
  | 'data_channel_error'
  | 'socket_connect_error'
  | 'chat_send_failed';

const MAX_PER_KIND = 5;
const MAX_TOTAL = 20;

const sentPerKind = new Map<string, number>();
let sentTotal = 0;

/** Report one client event. Safe to call from anywhere; never throws. */
export function reportClientEvent(
  kind: ClientEventKind,
  detail?: Record<string, unknown>,
  sessionId?: string | null
): void {
  try {
    if (sentTotal >= MAX_TOTAL) return;
    const kindCount = sentPerKind.get(kind) ?? 0;
    if (kindCount >= MAX_PER_KIND) return;
    sentPerKind.set(kind, kindCount + 1);
    sentTotal += 1;

    const body = JSON.stringify({
      kind,
      detail: detail ?? null,
      sessionId: sessionId ?? null,
    });

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // Blob with an explicit JSON type so express.json() parses it.
      const ok = navigator.sendBeacon('/api/client-events', new Blob([body], { type: 'application/json' }));
      if (ok) return;
    }
    void fetch('/api/client-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* fire-and-forget */ });
  } catch {
    // Telemetry must never break the app.
  }
}

// Dedupe repeated identical global errors (a render loop can rethrow the
// same message hundreds of times per second).
const seenMessages = new Set<string>();
let installed = false;

/** Register window-level error handlers once, from the app entry. */
export function installGlobalErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const message = String(event.message || 'unknown error');
    if (seenMessages.has(message)) return;
    seenMessages.add(message);
    reportClientEvent('js_error', {
      message: message.slice(0, 500),
      source: typeof event.filename === 'string' ? event.filename.slice(0, 300) : null,
      line: event.lineno ?? null,
      col: event.colno ?? null,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'unknown rejection');
    if (seenMessages.has(message)) return;
    seenMessages.add(message);
    reportClientEvent('unhandled_rejection', { message: message.slice(0, 500) });
  });
}
