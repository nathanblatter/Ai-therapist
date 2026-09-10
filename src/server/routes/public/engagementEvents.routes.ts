// Public engagement-telemetry beacon (Phase 2, flag-gated, default OFF).
// The client batches small allowlisted interaction events (turn timing,
// visibility changes, tool opens, check-in skips, ...) and flushes them
// here periodically and on page hide.
//
// IRB gate: every kind maps to a system_config features flag that defaults
// to false (migration 095). Gating is enforced HERE, not just client-side —
// events whose flag is off are dropped silently, so a stale or hostile
// client cannot record a disabled stream. Nothing in these events is
// conversation content; detail payloads are numeric/enum-shaped and capped.
import { Router, json } from 'express';
import rateLimit from 'express-rate-limit';
import { insertEngagementEvents } from '../../db/index.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { cleanSessionId, capDetail } from './clientEvents.routes.js';

// Kinds gated by features.telemetry_interaction_timing.
export const INTERACTION_TIMING_KINDS = ['turn_timing'] as const;

// Kinds gated by features.telemetry_engagement_events.
export const ENGAGEMENT_EVENT_KINDS = [
  'visibility_change',
  'scroll_back',
  'tool_open',
  'tool_close',
  'tool_event',
  'checkin_complete',
  'checkin_skip',
  'checkin_dismissed',
] as const;

const KIND_FLAG: Record<string, 'telemetry_interaction_timing' | 'telemetry_engagement_events'> = {
  ...Object.fromEntries(INTERACTION_TIMING_KINDS.map(k => [k, 'telemetry_interaction_timing' as const])),
  ...Object.fromEntries(ENGAGEMENT_EVENT_KINDS.map(k => [k, 'telemetry_engagement_events' as const])),
};

export const MAX_EVENTS_PER_BATCH = 50;

export default function engagementEventsRoutes(): Router {
  const router = Router();

  // The client flushes at most every few seconds plus once on page hide;
  // this is the backstop against a loop or a hostile script.
  const beaconLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  // POST /api/engagement-events - accept a batch of events. Body parsing is
  // route-local with a 16kb cap (index.ts skips the global json parser for
  // this path). Always 204: beacons cannot retry, and a disabled stream must
  // look identical to an accepted one from the client's perspective.
  router.post('/api/engagement-events', beaconLimiter, json({ limit: '16kb' }), async (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    let features: Record<string, unknown>;
    try {
      const config = await getSystemConfig();
      features = (config.features as Record<string, unknown>) ?? {};
    } catch {
      return res.sendStatus(204);
    }

    const userId = req.session?.userId ?? null;
    const accepted = [];
    for (const ev of events.slice(0, MAX_EVENTS_PER_BATCH)) {
      const kind = typeof ev?.kind === 'string' ? ev.kind : '';
      const flag = KIND_FLAG[kind];
      if (!flag || features[flag] !== true) continue;
      accepted.push({
        sessionId: cleanSessionId(ev.sessionId),
        userId,
        kind,
        detail: capDetail(ev.detail),
      });
    }

    if (accepted.length > 0) {
      try {
        await insertEngagementEvents(accepted);
      } catch (err) {
        // Telemetry must never surface errors to participants; log and move on.
        console.error('engagement-events insert failed:', err);
      }
    }

    res.sendStatus(204);
  });

  return router;
}
