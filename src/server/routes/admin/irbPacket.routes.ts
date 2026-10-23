// IRB continuing-review packet (ai-therapist-107). Researcher-only, scoped to
// the caller's organization (orgIdFor, fail-closed). Sandbox accounts get 404
// (the AE register convention: existence is not confirmable). Rendering an
// HTML or zip packet writes one data_access_log row (action 'export', kind
// 'irb_packet'); the JSON view, which the UI never calls on its own, does not
// (it is the machine-readable form of the same counts, logged when attached).
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { orgIdFor } from '../../middleware/org.js';
import { logDataAccess } from '../../db/index.js';
import { buildIrbPacket, renderIrbPacketHtml, streamIrbPacketZip } from '../../services/irbPacket.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('irbPacketRoutes');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Widest window one packet may cover (continuing review is annual; allow
 *  some slack for a late cycle). */
const MAX_WINDOW_DAYS = 400;

interface Window {
  from: string;
  to: string;
}

/** Parse ?from&to. Defaults: to = now, from = to - 365 days. Dates are
 *  accepted as YYYY-MM-DD (a bare date `to` is widened to the end of that
 *  day) or full ISO timestamps. */
export function parseWindow(query: Record<string, unknown>): Window | { error: string } {
  const toRaw = typeof query.to === 'string' && query.to.trim() ? query.to.trim() : null;
  const fromRaw = typeof query.from === 'string' && query.from.trim() ? query.from.trim() : null;
  const parse = (v: string, endOfDay: boolean): Date | null => {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = toRaw ? parse(toRaw, true) : new Date();
  if (!to) return { error: 'to must be an ISO date' };
  const from = fromRaw ? parse(fromRaw, false) : new Date(to.getTime() - 365 * DAY_MS);
  if (!from) return { error: 'from must be an ISO date' };
  if (from.getTime() > to.getTime()) return { error: 'from must be on or before to' };
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return { error: `window may not exceed ${MAX_WINDOW_DAYS} days` };
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function irbPacketRoutes(): Router {
  const router = Router();

  const denySandbox = (req: Request, res: Response, next: NextFunction): void => {
    if (req.session?.isSandbox === true) {
      log.warn(`Blocked sandbox account '${req.session?.username ?? 'unknown'}' from the IRB packet.`);
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
  const researcher = requireRole('researcher');
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    researcher(req, res, (err?: unknown) => (err ? next(err) : denySandbox(req, res, next)));
  };

  async function build(req: Request, res: Response): Promise<Awaited<ReturnType<typeof buildIrbPacket>> | null> {
    const w = parseWindow(req.query as Record<string, unknown>);
    if ('error' in w) {
      res.status(400).json({ error: w.error });
      return null;
    }
    const orgId = await orgIdFor(req);
    if (orgId === null) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    }
    return buildIrbPacket({ from: w.from, to: w.to, orgId });
  }

  function audit(
    req: Request,
    packet: { meta: { period: { from: string; to: string } } },
    format: 'html' | 'zip',
  ): void {
    void logDataAccess({
      accessedBy: req.session.userId ?? null,
      role: req.session.userRole ?? null,
      action: 'export',
      detail: { kind: 'irb_packet', format, from: packet.meta.period.from, to: packet.meta.period.to },
    });
  }

  router.get('/admin/api/irb/packet', gate, async (req, res) => {
    try {
      const packet = await build(req, res);
      if (packet) res.json(packet);
    } catch (err) {
      log.error({ err }, 'Failed to build IRB packet');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to build IRB packet' });
    }
  });

  router.get('/admin/api/irb/packet.html', gate, async (req, res) => {
    try {
      const packet = await build(req, res);
      if (!packet) return;
      audit(req, packet, 'html');
      res.set('Content-Type', 'text/html; charset=utf-8').send(renderIrbPacketHtml(packet));
    } catch (err) {
      log.error({ err }, 'Failed to render IRB packet');
      if (!res.headersSent) res.status(500).send('Failed to render IRB packet');
    }
  });

  router.get('/admin/api/irb/packet.zip', gate, async (req, res) => {
    try {
      const packet = await build(req, res);
      if (!packet) return;
      audit(req, packet, 'zip');
      const stamp = `${packet.meta.period.from.slice(0, 10)}_${packet.meta.period.to.slice(0, 10)}`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="irb-packet-${stamp}.zip"`);
      await streamIrbPacketZip(packet, res);
    } catch (err) {
      log.error({ err }, 'Failed to stream IRB packet zip');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to build IRB packet' });
      else res.end();
    }
  });

  return router;
}
