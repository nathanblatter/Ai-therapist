// Public client error beacon (pass-3 telemetry). The browser fires small
// fire-and-forget reports (navigator.sendBeacon / fetch keepalive) for
// failures that never reach the server otherwise: WebRTC negotiation, mic
// permission, data channel drops, chat send errors, uncaught JS errors.
//
// Deliberately narrow: the body is parsed route-locally with a 4kb limit
// (anything larger is rejected 413 before parsing), kinds come from a fixed
// allowlist, detail is a small JSON blob capped at ~2KB (truncated, not
// rejected — the client cannot retry a beacon), sessionId must match the id
// shapes this app actually uses, and the endpoint is rate limited per IP like
// the other public write routes. Responses carry no body the client cares
// about.
import { Router, json } from 'express';
import rateLimit from 'express-rate-limit';
import { insertClientEvent } from '../../db/index.js';

export const CLIENT_EVENT_KINDS = [
  'js_error',
  'unhandled_rejection',
  'webrtc_failed',
  'webrtc_disconnected',
  'mic_permission_denied',
  'sdp_fetch_failed',
  'data_channel_error',
  'socket_connect_error',
  'chat_send_failed',
] as const;

const KIND_SET = new Set<string>(CLIENT_EVENT_KINDS);

export const MAX_DETAIL_BYTES = 2048;

// Session IDs attached to beacons must look like the ids this app actually
// mints/uses: OpenAI realtime ('sess_...'), chat ('chat_...') or redteam
// ('redteam_...'), alphanumeric+underscore, bounded length. Anything else
// (junk, injection attempts, over-long strings) is stored as null.
const SESSION_ID_RE = /^(sess|chat|redteam)_\w{1,56}$/;

export function cleanSessionId(sessionId: unknown): string | null {
  return typeof sessionId === 'string' && sessionId.length <= 64 && SESSION_ID_RE.test(sessionId)
    ? sessionId
    : null;
}

/** Cap the detail payload: valid small objects pass through, oversized ones
 *  are replaced with a truncated marker (kind + size still tell the story). */
export function capDetail(detail: unknown): Record<string, unknown> | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== 'object' || Array.isArray(detail)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DETAIL_BYTES) {
    return { truncated: true, original_bytes: Buffer.byteLength(serialized, 'utf8') };
  }
  return detail as Record<string, unknown>;
}

export default function clientEventsRoutes(): Router {
  const router = Router();

  // A healthy client sends at most a handful of beacons per session; the
  // telemetry module also dedupes/samples client-side. This is the backstop
  // against a reload loop or a hostile script hammering the endpoint.
  const beaconLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

  // POST /api/client-events - accept one browser-reported event. Body parsing
  // is route-local with a tight 4kb cap so an oversized beacon is rejected
  // (413) before it is ever parsed; index.ts skips the global json parser for
  // this path so this limit actually applies.
  router.post('/api/client-events', beaconLimiter, json({ limit: '4kb' }), async (req, res) => {
    const { kind, detail, sessionId } = req.body || {};

    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      return res.status(400).json({ error: 'Unknown event kind' });
    }

    try {
      await insertClientEvent({
        sessionId: cleanSessionId(sessionId),
        userId: req.session?.userId ?? null,
        kind,
        detail: capDetail(detail),
        userAgent: (req.headers['user-agent'] || '').slice(0, 512) || null,
      });
    } catch (err) {
      // Telemetry must never surface errors to participants; log and move on.
      console.error('client-event insert failed:', err);
    }

    res.sendStatus(204);
  });

  return router;
}
