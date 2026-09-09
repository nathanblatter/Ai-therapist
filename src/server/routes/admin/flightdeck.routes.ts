// Flightdeck findings panel: read-only proxy to the flightdeck tracker so
// study staff can watch stress-test findings (in-app bug reports land there
// via bugReport.routes.ts) without leaving the admin portal. Uses a separate
// read-scoped key from the ingest key — the ingest key deliberately cannot
// read the tracker back.
import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';

function flightdeckBase(): string {
  return (process.env.FLIGHTDECK_URL || 'http://flightdeck:8080').replace(/\/$/, '');
}

interface FlightdeckItemRaw {
  ref?: string;
  type?: string;
  title?: string;
  body?: string | null;
  status?: string;
  priority?: string;
  source?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

const OPEN_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'blocked']);
const MAX_BODY_CHARS = 1500;

export default function flightdeckRoutes(): Router {
  const router = Router();

  router.get(
    '/admin/api/flightdeck/findings',
    requireAuth,
    requireRole('therapist', 'researcher'),
    async (_req, res) => {
      const key = process.env.FLIGHTDECK_READ_KEY;
      if (!key) {
        return res.status(503).json({ error: 'Flightdeck read access is not configured.' });
      }
      try {
        const r = await fetch(`${flightdeckBase()}/api/items?project=ai-therapist&limit=500`, {
          headers: { 'X-API-Key': key },
        });
        if (!r.ok) throw new Error(`flightdeck ${r.status}`);
        const raw = (await r.json()) as FlightdeckItemRaw[];
        const items = (Array.isArray(raw) ? raw : [])
          .map((i) => ({
            ref: i.ref ?? '',
            type: i.type ?? 'task',
            title: i.title ?? '',
            body: typeof i.body === 'string' ? i.body.slice(0, MAX_BODY_CHARS) : '',
            status: i.status ?? 'backlog',
            priority: i.priority ?? 'med',
            source: i.source ?? 'agent',
            tags: Array.isArray(i.tags) ? i.tags : [],
            created_at: i.created_at ?? null,
            updated_at: i.updated_at ?? null,
            open: OPEN_STATUSES.has(i.status ?? 'backlog'),
          }))
          // Open items first, then most recently updated.
          .sort((a, b) => {
            if (a.open !== b.open) return a.open ? -1 : 1;
            return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
          });
        res.json({ items });
      } catch (err) {
        console.error('flightdeck findings fetch failed:', err);
        res.status(502).json({ error: 'Could not reach the bug tracker.' });
      }
    }
  );

  return router;
}
