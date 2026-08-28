// Admin crisis-management routes (therapist/researcher): flag/unflag sessions
// and read crisis dashboards. Heavy logic lives in crisisDetection.service.
import { Router } from 'express';
import type { Request } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { broadcastAdminEventForSession } from '../../utils/adminBroadcast.js';
import { requireSessionClientAccess, careTeamScopeId } from '../../middleware/caseload.js';
import { orgIdFor } from '../../middleware/org.js';
import { isCareTeamRole } from '../../../shared/roles.js';
import {
  sessionExists,
  getSessionCrisisFlag,
  getAllCrisisData,
  getAllCrisisEvents,
  getSessionAccessInfo,
  isAssigned,
  getCaseloadClientIds,
} from '../../db/index.js';

// Caseload guard for session ids arriving via query string (the
// requireSessionClientAccess middleware only covers :sessionId path params).
// Non-care-team roles always pass; a therapist or caseworker passes only when
// the session exists, has an owner, and that owner is in their caseload.
async function careTeamMayAccessSession(req: Request, sessionId: string): Promise<boolean> {
  if (!isCareTeamRole(req.session.userRole)) return true;
  const info = await getSessionAccessInfo(sessionId);
  if (!info || info.user_id === null || info.user_id === undefined) return false;
  return isAssigned(req.session.userId!, Number(info.user_id));
}

// Summaries-tier scrub (spec section 2): strip the fields that can quote
// verbatim participant messages before a caseworker sees crisis payloads.
// crisis_events: risk_factors (matched keywords/snippets), intervention
// details, and free-text notes; risk_score_history: score_factors (stage-2
// LLM reasoning). Scores, severities, timestamps, and actors pass through.
const CRISIS_EVENT_VERBATIM_FIELDS = ['risk_factors', 'intervention_details', 'notes'] as const;
const RISK_HISTORY_VERBATIM_FIELDS = ['score_factors'] as const;
const INTERVENTION_VERBATIM_FIELDS = ['action_details', 'notes'] as const;

function scrubRows<T extends Record<string, unknown>>(
  rows: T[],
  fields: readonly string[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of fields) delete copy[field];
    return copy;
  });
}

export default function crisisRoutes(): Router {
  const router = Router();

  // POST /admin/api/sessions/:sessionId/crisis/flag - manually flag a session
  router.post('/admin/api/sessions/:sessionId/crisis/flag', requireRole('therapist', 'researcher', 'caseworker'), requireSessionClientAccess(), async (req, res) => {
    const { sessionId } = req.params;
    const { severity, notes } = req.body;

    if (!['low', 'medium', 'high'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity. Must be low, medium, or high.' });
    }

    try {
      const { flagSessionCrisis, logInterventionAction } = await import('../../services/crisisDetection.service.js');

      if (!(await sessionExists(sessionId))) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const riskScoreMap: Record<string, number> = { low: 25, medium: 50, high: 85 };
      const riskScore = riskScoreMap[severity];

      await flagSessionCrisis(
        sessionId,
        severity,
        riskScore,
        req.session.username!,
        'manual',
        null,
        [],
        notes || 'Manually flagged by admin'
      );

      await logInterventionAction(sessionId, 'manual_flag', {
        riskScore,
        severity,
        flaggedBy: req.session.username,
        notes,
      });

      // Steer the live model too (ai-therapist-112): a manual flag used to be
      // record/alert only, leaving the model blind to the human's judgment.
      // No-ops when the session has no live sideband (chat, already ended).
      const { injectManualFlagGuidance } = await import('../../services/crisisIntervention.service.js');
      const steered = await injectManualFlagGuidance(sessionId, severity, riskScore, req.session.username!);

      void broadcastAdminEventForSession(global.io, 'session:crisis-flagged', {
        sessionId,
        severity,
        riskScore,
        flaggedBy: req.session.username,
        flaggedAt: new Date(),
        message: `Session manually flagged as ${severity} risk by ${req.session.username}`,
      }, sessionId);

      res.json({
        success: true,
        message: 'Session flagged as crisis',
        sessionId,
        severity,
        riskScore,
        flaggedBy: req.session.username,
        flaggedAt: new Date(),
        modelSteered: steered,
      });
    } catch (err) {
      console.error('Failed to flag session as crisis:', err);
      res.status(500).json({ error: 'Failed to flag session' });
    }
  });

  // POST /admin/api/sessions/:sessionId/crisis/wind-down - gracefully end a
  // crisis session (ai-therapist-112). Asks the live model over the sideband
  // to surface crisis resources, close warmly, and call end_session itself;
  // hard-ends server-side after a grace window (immediately when no sideband).
  // Contrast with POST /admin/api/sessions/:id/end, which yanks the session
  // with no closure for the participant.
  router.post('/admin/api/sessions/:sessionId/crisis/wind-down', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
    const { sessionId } = req.params;
    try {
      const { getSession } = await import('../../db/index.js');
      const session = await getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.status !== 'active') {
        return res.status(400).json({ error: 'Session is not active' });
      }

      const { initiateCrisisWindDown } = await import('../../services/crisisIntervention.service.js');
      const { injected } = await initiateCrisisWindDown(sessionId, req.session.username!);

      void broadcastAdminEventForSession(global.io, 'session:crisis-wind-down', {
        sessionId,
        initiatedBy: req.session.username,
        injected,
        at: new Date(),
      }, sessionId);

      res.json({
        success: true,
        injected,
        message: injected
          ? 'Model asked to share resources and close the session; hard-end backstop scheduled.'
          : 'No live sideband — session is being ended server-side now.',
      });
    } catch (err) {
      console.error('Failed to initiate crisis wind-down:', err);
      res.status(500).json({ error: 'Failed to initiate crisis wind-down' });
    }
  });

  // DELETE /admin/api/sessions/:sessionId/crisis/flag - remove a crisis flag
  router.delete('/admin/api/sessions/:sessionId/crisis/flag', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
    const { sessionId } = req.params;
    const { notes } = req.body;

    try {
      const { unflagSessionCrisis } = await import('../../services/crisisDetection.service.js');

      const flag = await getSessionCrisisFlag(sessionId);
      if (!flag) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (!flag.crisis_flagged) {
        return res.status(400).json({ error: 'Session is not flagged as crisis' });
      }

      await unflagSessionCrisis(sessionId, req.session.username!, notes || 'Manually unflagged by admin');

      void broadcastAdminEventForSession(global.io, 'session:crisis-unflagged', {
        sessionId,
        unflaggedBy: req.session.username,
        unflaggedAt: new Date(),
        message: `Crisis flag removed by ${req.session.username}`,
      }, sessionId);

      res.json({
        success: true,
        message: 'Crisis flag removed',
        sessionId,
        unflaggedBy: req.session.username,
        unflaggedAt: new Date(),
      });
    } catch (err) {
      console.error('Failed to unflag session:', err);
      res.status(500).json({ error: 'Failed to unflag session' });
    }
  });

  // GET /admin/api/crisis/all - comprehensive crisis dashboard data
  router.get('/admin/api/crisis/all', requireRole('therapist', 'researcher', 'caseworker'), async (req, res) => {
    try {
      const scope = await careTeamScopeId(req);
      const orgId = scope === null ? await orgIdFor(req) : null;
      const data = await getAllCrisisData(scope, orgId);
      if (req.session.userRole === 'caseworker') {
        data.crisisEvents = scrubRows(data.crisisEvents, CRISIS_EVENT_VERBATIM_FIELDS);
        data.riskScoreHistory = scrubRows(data.riskScoreHistory, RISK_HISTORY_VERBATIM_FIELDS);
        data.interventionActions = scrubRows(data.interventionActions, INTERVENTION_VERBATIM_FIELDS);
      }
      res.json(data);
    } catch (err: unknown) {
      console.error('[Crisis API] Failed to fetch comprehensive crisis data:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to fetch crisis management data', details: errMsg });
    }
  });

  // GET /admin/api/crisis/events - crisis events (all, or for one session)
  router.get('/admin/api/crisis/events', requireRole('therapist', 'researcher', 'caseworker'), async (req, res) => {
    const { sessionId } = req.query;
    const isCaseworker = req.session.userRole === 'caseworker';

    try {
      if (sessionId) {
        // Session id arrives via query string, so the path-param caseload
        // middleware cannot cover it; enforce the same 404 semantics here
        // (extended to caseworkers per spec section 2).
        if (!(await careTeamMayAccessSession(req, String(sessionId)))) {
          return res.status(404).json({ error: 'Not found' });
        }
        const { getSessionCrisisEvents } = await import('../../services/crisisDetection.service.js');
        const events = await getSessionCrisisEvents(String(sessionId));
        res.json({ events: isCaseworker ? scrubRows(events as Record<string, unknown>[], CRISIS_EVENT_VERBATIM_FIELDS) : events });
      } else {
        const scope = await careTeamScopeId(req);
        const orgId = scope === null ? await orgIdFor(req) : null;
        const events = await getAllCrisisEvents(scope, orgId);
        res.json({ events: isCaseworker ? scrubRows(events, CRISIS_EVENT_VERBATIM_FIELDS) : events });
      }
    } catch (err) {
      console.error('Failed to fetch crisis events:', err);
      res.status(500).json({ error: 'Failed to fetch crisis events' });
    }
  });

  // GET /admin/api/sessions/:sessionId/risk-history - the per-message risk
  // timeline for one session (scores, severity, and the stage-2 LLM's context
  // judgment + reasoning from score_factors). Drives SessionDetail's timeline.
  router.get('/admin/api/sessions/:sessionId/risk-history', requireRole('therapist', 'researcher', 'caseworker'), requireSessionClientAccess(), async (req, res) => {
    try {
      const { getSessionRiskHistory } = await import('../../services/crisisDetection.service.js');
      const history = await getSessionRiskHistory(req.params.sessionId);
      // Caseworker scrub (spec section 2): scores/severity/timestamps only —
      // score_factors carries the stage-2 LLM's reasoning, which can quote
      // participant messages.
      if (req.session.userRole === 'caseworker') {
        return res.json({ history: scrubRows(history as Record<string, unknown>[], RISK_HISTORY_VERBATIM_FIELDS) });
      }
      res.json({ history });
    } catch (err) {
      console.error('Failed to fetch session risk history:', err);
      res.status(500).json({ error: 'Failed to fetch session risk history' });
    }
  });

  // GET /admin/api/crisis/active - active crisis sessions
  router.get('/admin/api/crisis/active', requireRole('therapist', 'researcher', 'caseworker'), async (req, res) => {
    try {
      const { getActiveCrisisSessions } = await import('../../services/crisisDetection.service.js');
      let sessions = await getActiveCrisisSessions();
      // getActiveCrisisSessions lives in the crisis-detection service, not a
      // scoped db module, so the caseload filter is applied here. Its payload
      // is flag metadata only (no message content) — summaries-tier safe.
      const scope = await careTeamScopeId(req);
      if (scope !== null) {
        const clientIds = new Set(await getCaseloadClientIds(scope));
        sessions = sessions.filter((s) => {
          const uid = (s as { user_id?: number | null }).user_id;
          return uid !== null && uid !== undefined && clientIds.has(Number(uid));
        });
      }
      res.json({ sessions });
    } catch (err) {
      console.error('Failed to fetch active crisis sessions:', err);
      res.status(500).json({ error: 'Failed to fetch active crisis sessions' });
    }
  });

  return router;
}
