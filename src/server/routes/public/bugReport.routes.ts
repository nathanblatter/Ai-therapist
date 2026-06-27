// Bug report -> flightdeck. Public (no auth/session); mounted before the
// session + IP-geo middleware so reports work from anywhere.
import { Router } from 'express';

export default function bugReportRoutes(): Router {
  const router = Router();

  router.post('/api/bug-report', async (req, res) => {
    const key = process.env.FLIGHTDECK_INGEST_KEY;
    if (!key) return res.status(503).json({ error: 'Bug reporting is not configured.' });

    const { message, severity, url, meta } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A description is required.' });
    }

    const base = (process.env.FLIGHTDECK_URL || 'http://flightdeck:8080').replace(/\/$/, '');
    try {
      const r = await fetch(base + '/api/ingest/bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({
          site: 'ai-therapist',
          url: url || '',
          message: message.trim().slice(0, 5000),
          severity: ['low', 'med', 'high', 'urgent'].includes(severity) ? severity : 'med',
          meta: meta || {},
        }),
      });
      if (!r.ok) throw new Error('ingest ' + r.status);
      res.json({ ok: true });
    } catch (err) {
      console.error('bug-report forward failed:', err);
      res.status(502).json({ error: 'Could not reach the bug tracker.' });
    }
  });

  return router;
}
