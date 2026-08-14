// Admin ops telemetry API (pass-3 telemetry): in-process HTTP metrics from
// the opsMetrics collector (rolling 60-min window), process health, the
// client error-beacon aggregation, and the product funnel derived from
// existing tables. Read-only, therapist+researcher.
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { opsMetrics } from '../../services/opsMetrics.service.js';
import { getClientEventStats, getFunnel } from '../../db/index.js';

export default function opsRoutes(): Router {
  const router = Router();

  // GET /admin/api/analytics/ops - request/error/latency snapshot + process
  // health + top client-error kinds (7d).
  router.get('/admin/api/analytics/ops', requireRole('therapist', 'researcher'), async (_req, res) => {
    try {
      const snapshot = opsMetrics.snapshot();

      const requests: Record<string, number> = {};
      const errorRates: Record<string, { rate_4xx: number; rate_5xx: number; count_4xx: number; count_5xx: number }> = {};
      const latency: Record<string, { p50_ms: number | null; p95_ms: number | null }> = {};
      for (const [group, stats] of Object.entries(snapshot)) {
        requests[group] = stats.requests;
        errorRates[group] = {
          count_4xx: stats.status_4xx,
          count_5xx: stats.status_5xx,
          rate_4xx: stats.requests > 0 ? stats.status_4xx / stats.requests : 0,
          rate_5xx: stats.requests > 0 ? stats.status_5xx / stats.requests : 0,
        };
        latency[group] = { p50_ms: stats.p50_ms, p95_ms: stats.p95_ms };
      }

      // Beacon aggregation is best-effort: if migration 059 hasn't run yet the
      // rest of the ops dashboard should still work.
      let clientErrors: Awaited<ReturnType<typeof getClientEventStats>> = [];
      try {
        clientErrors = await getClientEventStats(7);
      } catch (err) {
        console.error('Failed to fetch client-event stats:', err);
      }

      const memory = process.memoryUsage();
      res.json({
        window_minutes: opsMetrics.windowMinutes,
        requests,
        errorRates,
        latency,
        uptime: Math.round(process.uptime()),
        memory: { rss: memory.rss, heap_used: memory.heapUsed },
        clientErrors,
      });
    } catch (err) {
      console.error('Failed to fetch ops telemetry:', err);
      res.status(500).json({ error: 'Failed to fetch ops telemetry' });
    }
  });

  // GET /admin/api/analytics/funnel?days=30 - staged product funnel derived
  // from therapy_sessions/messages/tool_invocations.
  router.get('/admin/api/analytics/funnel', requireRole('therapist', 'researcher'), async (req, res) => {
    const rawDays = req.query.days ? parseInt(String(req.query.days), 10) : 30;
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, rawDays)) : 30;
    try {
      const funnel = await getFunnel(days);
      res.json({ days, funnel });
    } catch (err) {
      console.error('Failed to fetch funnel analytics:', err);
      res.status(500).json({ error: 'Failed to fetch funnel analytics' });
    }
  });

  return router;
}
