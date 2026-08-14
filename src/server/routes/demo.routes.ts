// Demo dashboard interceptor. For magic-link 'demo' accounts ONLY, admin API
// requests are answered with fully synthetic fixtures — the real admin routers
// (and the database behind them) are never reached, so no real participant data
// can ever leak to a demo viewer.
//
// This router is mounted BEFORE the real admin/users routers. Its first
// middleware short-circuits out (next('router')) for every non-demo request, so
// therapists/researchers/participants are completely unaffected. Demo accounts
// keep full access to the REAL participant therapy endpoints (/token, /api/chat,
// /api/sessions, /logs/batch, /api/users/preferences, ...) because those paths
// are intentionally not matched here.
import { Router } from 'express';
import {
  demoActiveSessions,
  demoSessionsList,
  demoSessionDetail,
  demoRiskHistory,
  demoAnalytics,
  demoCrisisAll,
  demoRateLimitedUsers,
  demoExport,
  demoToolAnalytics,
  demoCostAnalytics,
  demoPairwiseAnalytics,
  demoEvalTrend,
  demoCalibration,
  demoUsers,
  demoUserById,
  demoUserProfile,
  demoUserBrief,
  demoUserSessions,
  demoOps,
  demoFunnel,
  demoKnowledge,
  demoKnowledgeUsage,
  demoRerankDecisions,
  demoAdverseEvents,
  demoAdverseEventById,
} from '../demo/demoFixtures.js';

export default function demoRoutes(): Router {
  const router = Router();

  // Gate: anything that isn't a demo account leaves this router immediately.
  router.use((req, _res, next) => {
    if (req.session?.userRole === 'demo') return next();
    return next('router');
  });

  // ---- Read endpoints the dashboard actually calls (synthetic data) ----

  router.get('/admin/api/sessions/active', (_req, res) => {
    res.json(demoActiveSessions());
  });

  router.get('/admin/api/sessions', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '50')) || 50;
    const page = parseInt(String(req.query.page ?? '1')) || 1;
    res.json(demoSessionsList(limit, page));
  });

  // Session-detail sub-resources (registered before /:sessionId).
  router.get('/admin/api/sessions/:sessionId/redaction-status', (req, res) => {
    res.json({ sessionId: req.params.sessionId, pendingCount: 0, allComplete: true });
  });
  router.get('/admin/api/sessions/:sessionId/recording-info', (_req, res) => {
    res.json({ available: false, status: 'none' });
  });
  router.get('/admin/api/sessions/:sessionId/risk-history', (req, res) => {
    res.json(demoRiskHistory(req.params.sessionId));
  });
  router.get('/admin/api/sessions/:sessionId/insights', (_req, res) => {
    // Panel treats 404 as "no insights yet" and renders gracefully.
    res.status(404).json({ error: 'No insights for this session (demo)' });
  });

  router.get('/admin/api/sessions/:sessionId', (req, res) => {
    const detail = demoSessionDetail(req.params.sessionId);
    if (!detail) return res.status(404).json({ error: 'Session not found' });
    res.json(detail);
  });

  router.get('/admin/api/analytics', (_req, res) => {
    res.json(demoAnalytics());
  });

  // Dashboard sub-panels (ai-therapist-114): these MUST be registered — the
  // catch-all's `{}` fallback crashed every panel that dereferences arrays
  // from the payload, white-screening the whole Dashboard tab.
  router.get('/admin/api/analytics/tools', (_req, res) => {
    res.json(demoToolAnalytics());
  });
  router.get('/admin/api/analytics/cost', (_req, res) => {
    res.json(demoCostAnalytics());
  });
  router.get('/admin/api/analytics/pairwise', (_req, res) => {
    res.json(demoPairwiseAnalytics());
  });
  router.get('/admin/api/analytics/evals', (_req, res) => {
    res.json(demoEvalTrend());
  });
  router.get('/admin/api/evals/calibration', (_req, res) => {
    res.json(demoCalibration());
  });

  // Ops telemetry + product funnel (pass-3 surfaces on the Dashboard).
  router.get('/admin/api/analytics/ops', (_req, res) => {
    res.json(demoOps());
  });
  router.get('/admin/api/analytics/funnel', (req, res) => {
    const days = parseInt(String(req.query.days ?? '30')) || 30;
    res.json(demoFunnel(days));
  });

  router.get('/admin/api/crisis/all', (_req, res) => {
    res.json(demoCrisisAll());
  });
  router.get('/admin/api/crisis/active', (_req, res) => {
    res.json({ sessions: demoActiveSessions().sessions.filter(s => s.crisis_flagged) });
  });
  router.get('/admin/api/crisis/events', (_req, res) => {
    res.json({ events: demoCrisisAll().crisisEvents });
  });

  // IRB adverse events: Client B's crisis report, already submitted.
  router.get('/admin/api/adverse-events', (req, res) => {
    res.json(demoAdverseEvents(typeof req.query.status === 'string' ? req.query.status : undefined));
  });
  router.get('/admin/api/adverse-events/:id', (req, res) => {
    const report = demoAdverseEventById(parseInt(req.params.id, 10));
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  });

  // Participant profile drill-down (ai-therapist-110): the "what the AI
  // remembers" page for each caseload client.
  router.get('/admin/api/users/:userId/profile', (req, res) => {
    const bundle = demoUserProfile(parseInt(req.params.userId, 10));
    if (!bundle) return res.status(404).json({ error: 'User not found' });
    res.json(bundle);
  });
  router.get('/admin/api/users/:userId/brief', (req, res) => {
    const brief = demoUserBrief(parseInt(req.params.userId, 10));
    if (!brief) return res.status(404).json({ error: 'User not found' });
    res.json(brief);
  });
  router.get('/admin/api/users/:userId/sessions', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '50')) || 50;
    res.json(demoUserSessions(parseInt(req.params.userId, 10), limit));
  });

  // Knowledge base curation view + retrieval usage + rerank decision log.
  router.get('/admin/api/knowledge', (_req, res) => {
    res.json(demoKnowledge());
  });
  router.get('/admin/api/knowledge/usage', (_req, res) => {
    res.json(demoKnowledgeUsage());
  });
  router.get('/admin/api/knowledge/rerank-decisions', (_req, res) => {
    res.json(demoRerankDecisions());
  });

  router.get('/admin/api/rate-limits/users', (_req, res) => {
    res.json(demoRateLimitedUsers());
  });

  router.get('/admin/api/export', (req, res) => {
    const rows = demoExport();
    if (String(req.query.format) === 'csv') {
      const headers = Object.keys(rows[0]);
      const csv = [
        headers.join(','),
        ...rows.map(r => headers.map(h => JSON.stringify((r as Record<string, unknown>)[h] ?? '')).join(',')),
      ].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="demo-export.csv"');
      return res.send(csv);
    }
    res.json({ data: rows, count: rows.length, demo: true });
  });

  // Fake "list users" view (UserManagement) — the synthetic caseload roster.
  router.get('/api/users', (_req, res) => {
    res.json(demoUsers());
  });
  // Case-insensitive + optional trailing slash: Express matches its string
  // routes case-insensitively and non-strictly, so these regex layers must be
  // equally permissive or PUT /api/users/123/ (or /API/users/123) would skip
  // the interceptor and reach the real handler.
  router.get(/^\/api\/users\/(\d+)\/?$/i, (req, res) => {
    const id = parseInt(req.params[0], 10);
    const user = demoUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  // User-management writes (create/edit/delete) must never reach the real
  // /api/users handlers for a demo account — a demo session IS authenticated,
  // and PUT /api/users/:id allows self-edits. Accept and discard instead.
  // /api/users/preferences is deliberately NOT matched (non-numeric segment):
  // demo accounts keep their real, harmless preference writes.
  router.all(/^\/api\/users(\/\d+)?\/?$/i, (_req, res) => {
    res.json({ success: true, demo: true, message: 'Demo mode — changes are not saved.' });
  });

  // ---- Everything else under the admin API surface ----
  // Writes (including the newer POST surfaces: sideband trigger-tool /
  // update-session / disconnect, knowledge create/edit/approve/delete, config
  // PUTs, adverse-event transitions) are accepted but never persisted;
  // unmatched GETs return an empty but valid shape. This is the safety net:
  // no admin path ever falls through to a real handler for a demo account.
  router.all(/^\/admin\/api\//i, (req, res) => {
    if (req.method === 'GET') {
      return res.json({});
    }
    res.json({ success: true, demo: true, message: 'Demo mode — changes are not saved.' });
  });

  return router;
}
