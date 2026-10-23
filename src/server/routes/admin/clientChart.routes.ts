// Clinician chart bundle download (ai-therapist-199 item 3): the therapist
// equivalent of the participant's own /api/me/export, one zip per client.
//
// Access: requireRole('therapist','researcher') (caseworkers 403 — the
// bundle carries clinical content they never see), then requireClientAccess
// (a therapist exports only caseload clients, 404 otherwise; a researcher
// only clients in their organization, 404 otherwise). The scope rule inside
// the bundle lives in services/clientChart.service.ts: therapists get the
// full record, researchers the summary tier.
//
// Every download writes ONE data_access_log row (action 'export', detail
// {kind:'client_chart', files:[...]}) before the zip streams.
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { requireClientAccess } from '../../middleware/caseload.js';
import { orgIdFor, resolveClientOrgId } from '../../middleware/org.js';
import { isCareTeamRole } from '../../../shared/roles.js';
import { getUserById, logDataAccess } from '../../db/index.js';
import {
  buildClientChart,
  chartZipFilename,
  streamChartZip,
  type ChartViewerRole,
} from '../../services/clientChart.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('clientChartRoutes');

/**
 * Resolve the target client for an already role+caseload-gated request.
 * Mirrors practiceAssignments.routes: no such user / not a participant ->
 * 404; researcher whose org differs from the client's -> 404. Returns the
 * client plus the caller's org (researchers only) or null after writing the
 * response.
 */
async function resolveClient(
  req: Request,
  res: Response
): Promise<{ userid: number; username: string; callerOrgId: number | null } | null> {
  const clientId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(clientId) || clientId <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return null;
  }
  const client = await getUserById(clientId);
  if (!client || client.role !== 'participant') {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  let callerOrgId: number | null = null;
  if (!isCareTeamRole(req.session.userRole)) {
    callerOrgId = await orgIdFor(req);
    const clientOrg = await resolveClientOrgId(client, req);
    if (callerOrgId === null || clientOrg !== callerOrgId) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
  }
  return { userid: client.userid, username: client.username, callerOrgId };
}

export default function clientChartRoutes(): Router {
  const router = Router();

  // GET /admin/api/clients/:userId/chart.zip
  router.get(
    '/admin/api/clients/:userId/chart.zip',
    requireRole('therapist', 'researcher'),
    requireClientAccess(),
    async (req, res) => {
      try {
        const resolved = await resolveClient(req, res);
        if (!resolved) return;

        const role = req.session.userRole as ChartViewerRole;
        const chart = await buildClientChart(
          { userid: resolved.userid, username: resolved.username },
          { userId: req.session.userId as number, username: String(req.session.username ?? ''), role },
          { orgId: resolved.callerOrgId }
        );

        // Access audit (091): one row per export, naming the bundle contents.
        void logDataAccess({
          accessedBy: req.session.userId ?? null,
          role: req.session.userRole ?? null,
          action: 'export',
          userId: resolved.userid,
          detail: {
            kind: 'client_chart',
            scope: chart.scope,
            files: chart.manifest,
            rowCounts: chart.rowCounts,
          },
        });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${chartZipFilename(chart.client, chart.generatedAt)}"`);
        await streamChartZip(chart, res);
      } catch (err) {
        log.error({ err }, 'Failed to build client chart bundle');
        if (!res.headersSent) res.status(500).json({ error: 'Failed to build chart bundle' });
        else res.end();
      }
    }
  );

  return router;
}
