// Read side of the telemetry tables (ai-therapist-205). Three write-only
// stores had finished queries and no caller: de-identified admin usage
// (096), Phase 2 engagement events + the session-rhythm view (095), and
// per-turn latency (057). Everything here is aggregate-only and
// researcher-only: product/ops telemetry is study infrastructure, not
// clinical material.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getAdminUsageStats,
  getAdminViewReach,
  getAdminViewUsageByRole,
  getEngagementEventStats,
  getSessionRhythmSummary,
  getLatencyStats,
  getLatencyDrift,
  getSessionLatency,
} from '../../db/index.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('telemetryRoutes');

/** Phase 2 flags that gate the engagement stream (migration 095). */
export const ENGAGEMENT_FLAGS = ['telemetry_interaction_timing', 'telemetry_engagement_events'] as const;

function parseDays(raw: unknown, fallback: number, max = 365): number {
  const n = raw ? parseInt(String(raw), 10) : fallback;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

// Session ids are app-minted (sess_...) or uuids; anything else is rejected
// before it reaches the query.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export default function telemetryRoutes(): Router {
  const router = Router();

  // GET /admin/api/telemetry/admin-usage?days=30 - which admin screens get
  // used, by which role cohort, how often, plus error/overlay kind counts.
  router.get('/admin/api/telemetry/admin-usage', requireRole('researcher'), async (req, res) => {
    const days = parseDays(req.query.days, 30);
    try {
      const [kinds, reach, byRole] = await Promise.all([
        getAdminUsageStats(days),
        getAdminViewReach(days),
        getAdminViewUsageByRole(days),
      ]);
      res.json({ days, kinds, reach, byRole });
    } catch (err) {
      log.error({ err }, 'Failed to fetch admin usage telemetry');
      res.status(500).json({ error: 'Failed to fetch admin usage telemetry' });
    }
  });

  // GET /admin/api/telemetry/engagement?days=30 - Phase 2 engagement kinds
  // (flag-gated, default off) and the session-rhythm habit metrics (derived
  // from timestamps the study already collects, so never gated). The flag
  // state is returned so the panel can say honestly why a stream is empty.
  router.get('/admin/api/telemetry/engagement', requireRole('researcher'), async (req, res) => {
    const days = parseDays(req.query.days, 30);
    try {
      const flags: Record<string, boolean> = {};
      try {
        const config = await getSystemConfig();
        const features = (config.features as Record<string, unknown>) ?? {};
        for (const flag of ENGAGEMENT_FLAGS) flags[flag] = features[flag] === true;
      } catch (err) {
        log.error({ err }, 'Failed to read telemetry flags');
        for (const flag of ENGAGEMENT_FLAGS) flags[flag] = false;
      }
      const [kinds, rhythm] = await Promise.all([
        getEngagementEventStats(days),
        getSessionRhythmSummary(days),
      ]);
      res.json({ days, flags, kinds, rhythm });
    } catch (err) {
      log.error({ err }, 'Failed to fetch engagement telemetry');
      res.status(500).json({ error: 'Failed to fetch engagement telemetry' });
    }
  });

  // GET /admin/api/telemetry/latency?days=7[&sessionId=...] - per-channel
  // p50/p95 TTFA + total, within-session drift by turn position, and
  // (optionally) the measured turns of one session.
  router.get('/admin/api/telemetry/latency', requireRole('researcher'), async (req, res) => {
    const days = parseDays(req.query.days, 7);
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
    if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    try {
      const [channels, drift, session] = await Promise.all([
        getLatencyStats(days),
        getLatencyDrift(days),
        sessionId ? getSessionLatency(sessionId) : Promise.resolve(null),
      ]);
      res.json({ days, channels, drift, session: sessionId ? { sessionId, turns: session } : null });
    } catch (err) {
      log.error({ err }, 'Failed to fetch latency telemetry');
      res.status(500).json({ error: 'Failed to fetch latency telemetry' });
    }
  });

  return router;
}
