// Demo dashboard interceptor. For magic-link 'demo' accounts ONLY, admin API
// requests are answered with fully synthetic fixtures — the real admin routers
// (and the database behind them) are never reached, so no real participant data
// can ever leak to a resume viewer.
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
  demoAnalytics,
  demoCrisisAll,
  demoRateLimitedUsers,
  demoExport,
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
  router.get('/admin/api/sessions/:sessionId/risk-history', (_req, res) => {
    res.json({ history: [] });
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

  router.get('/admin/api/crisis/all', (_req, res) => {
    res.json(demoCrisisAll());
  });
  router.get('/admin/api/crisis/active', (_req, res) => {
    res.json({ sessions: demoActiveSessions().sessions.filter(s => s.crisis_flagged) });
  });
  router.get('/admin/api/crisis/events', (_req, res) => {
    res.json({ events: demoCrisisAll().crisisEvents });
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

  // Fake "list users" view (UserManagement) — synthetic roster, no real users.
  router.get('/api/users', (_req, res) => {
    res.json({
      users: [
        { userid: 9001, username: 'participant_042', role: 'participant', created_at: new Date().toISOString() },
        { userid: 9002, username: 'participant_017', role: 'participant', created_at: new Date().toISOString() },
        { userid: 9100, username: 'dr_demo', role: 'therapist', created_at: new Date().toISOString() },
        { userid: 9200, username: 'research_demo', role: 'researcher', created_at: new Date().toISOString() },
      ],
    });
  });
  router.get(/^\/api\/users\/\d+$/, (_req, res) => {
    res.json({ user: { userid: 9001, username: 'participant_042', role: 'participant' } });
  });

  // ---- Everything else under the admin API surface ----
  // Writes are accepted but never persisted; unmatched GETs return an empty but
  // valid shape. This is the safety net: no admin path ever falls through to a
  // real handler for a demo account.
  router.all(/^\/admin\/api\//, (req, res) => {
    if (req.method === 'GET') {
      return res.json({});
    }
    res.json({ success: true, demo: true, message: 'Demo mode — changes are not saved.' });
  });

  return router;
}
