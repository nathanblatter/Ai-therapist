// Health check — no auth, mounted before session/IP middleware.
import { Router } from 'express';

export default function healthRoutes(): Router {
  const router = Router();
  const startTime = Date.now();

  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  return router;
}
