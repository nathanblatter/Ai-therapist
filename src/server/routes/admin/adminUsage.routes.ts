// De-identified admin usage telemetry ingest (migration 096). Authenticated
// (so only staff can write) but deliberately identity-stripping: the row
// carries the session's coarse ROLE and a client-minted random per-tab
// usage_session_id — never userId, username, IP, or user agent.
//
// Scrubbing is enforced here, not just client-side: kinds are allowlisted,
// detail payloads are capped and passed through a per-kind key allowlist so
// a participant/session/user identifier can't ride in even by accident.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../../middleware/auth.js';
import { insertAdminUsageEvents } from '../../db/index.js';
import { getSystemConfig } from '../../utils/sessionHelpers.js';
import { capDetail } from '../public/clientEvents.routes.js';

// Allowed detail keys per kind. Values are additionally length-capped.
export const ADMIN_USAGE_KINDS: Record<string, ReadonlySet<string>> = {
  view_open: new Set(['view']),
  view_heartbeat: new Set(['view', 'visible_ms']),
  overlay_open: new Set(['overlay']),
  js_error: new Set(['message', 'source']),
  api_error: new Set(['path', 'status']),
};

export const MAX_EVENTS_PER_BATCH = 50;
const MAX_VALUE_CHARS = 300;

// Numeric path segments, UUIDs, and app id shapes (sess_/chat_/...) become
// placeholders so an api_error can never name a concrete resource.
export function templatePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  return path
    .slice(0, MAX_VALUE_CHARS)
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b(sess|chat|redteam)_\w+/g, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function scrubDetail(kind: string, detail: unknown): Record<string, unknown> | null {
  const capped = capDetail(detail);
  if (!capped) return null;
  const allowed = ADMIN_USAGE_KINDS[kind];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(capped)) {
    if (!allowed.has(key)) continue;
    if (key === 'path') {
      out.path = templatePath(value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.round(value);
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_VALUE_CHARS);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const USAGE_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function adminUsageRoutes(): Router {
  const router = Router();

  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  // POST /admin/api/usage-events - batch ingest. Always 204 to accepted
  // callers: beacons cannot retry, and a disabled stream must look identical
  // to an accepted one.
  router.post(
    '/admin/api/usage-events',
    requireRole('therapist', 'researcher', 'caseworker'),
    limiter,
    async (req, res) => {
      try {
        const config = await getSystemConfig();
        const features = (config.features as Record<string, unknown>) ?? {};
        if (features.telemetry_admin_usage !== true) return res.sendStatus(204);
      } catch {
        return res.sendStatus(204);
      }

      const usageSessionId = req.body?.usageSessionId;
      if (typeof usageSessionId !== 'string' || !USAGE_SESSION_RE.test(usageSessionId)) {
        return res.sendStatus(204);
      }

      // Coarse cohort only — the ONLY session-derived value that may be stored.
      const role = typeof req.session?.userRole === 'string' ? req.session.userRole : null;

      const events = Array.isArray(req.body?.events) ? req.body.events : [];
      const accepted = [];
      for (const ev of events.slice(0, MAX_EVENTS_PER_BATCH)) {
        const kind = typeof ev?.kind === 'string' ? ev.kind : '';
        if (!(kind in ADMIN_USAGE_KINDS)) continue;
        accepted.push({
          usageSessionId,
          seq: Number.isFinite(ev?.seq) ? Math.round(ev.seq) : null,
          role,
          kind,
          detail: scrubDetail(kind, ev.detail),
        });
      }

      if (accepted.length > 0) {
        try {
          await insertAdminUsageEvents(accepted);
        } catch (err) {
          console.error('admin usage-events insert failed:', err);
        }
      }

      res.sendStatus(204);
    }
  );

  return router;
}
