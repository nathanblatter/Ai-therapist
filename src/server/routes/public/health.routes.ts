// Health check — no auth, mounted before session/IP middleware.
import { Router } from 'express';
import { pingDatabase } from '../../db/health.queries.js';

export default function healthRoutes(): Router {
  const router = Router();
  const startTime = Date.now();

  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  // Deep check (ai-therapist-159): also proves the DB path. The container
  // healthcheck and the prod uptime monitor hit THIS route — the shallow /
  // and /health stay up when the DB is broken, which masked the 155 incident
  // (prod "healthy" for hours with all DB auth failing).
  router.get('/health/deep', async (_req, res) => {
    const db = await pingDatabase();
    res.status(db ? 200 : 503).json({
      status: db ? 'ok' : 'degraded',
      db,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  return router;
}
