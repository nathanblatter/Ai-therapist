// Admin sideband control API (therapist/researcher): inspect sideband
// connection state and push live instruction updates / disconnects to an active
// session. The sidebandManager service is imported lazily because the feature
// is currently disabled (OpenAI returns 404 for WebRTC sessions).
import { Router } from 'express';
import type { Request } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { broadcastAdminEventForSession } from '../../utils/adminBroadcast.js';
import { requireSessionClientAccess, therapistScopeId } from '../../middleware/caseload.js';
import {
  getActiveSidebandSessions,
  logSidebandAction,
  getSessionAccessInfo,
  isAssigned,
  getCaseloadClientIds,
} from '../../db/index.js';

// Caseload guard for session ids arriving in the request BODY (most sideband
// control endpoints), where the :sessionId path-param middleware cannot apply.
// Non-therapists always pass; a therapist passes only when the session exists,
// has an owner, and that owner is in their caseload. Mirrors the middleware's
// 404-never-403 semantics.
async function therapistMayAccessSession(req: Request, sessionId: string): Promise<boolean> {
  if (req.session.userRole !== 'therapist') return true;
  const info = await getSessionAccessInfo(sessionId);
  if (!info || info.user_id === null || info.user_id === undefined) return false;
  return isAssigned(req.session.userId!, Number(info.user_id));
}

export default function sidebandRoutes(): Router {
  const router = Router();

  // POST /admin/api/sessions/:sessionId/update-instructions - update AI instructions mid-session
  router.post('/admin/api/sessions/:sessionId/update-instructions', requireRole('therapist', 'researcher'), requireSessionClientAccess(), async (req, res) => {
    const { sessionId } = req.params;
    const { instructions } = req.body;

    if (!instructions) {
      return res.status(400).json({ error: 'instructions field is required' });
    }

    try {
      const { sidebandManager } = await import('../../services/sidebandManager.service.js');

      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.updateSession(sessionId, { instructions });

      void broadcastAdminEventForSession(global.io, 'session:instructions-updated', {
        sessionId,
        updatedBy: req.session.username,
        timestamp: new Date(),
      }, sessionId);

      console.log(`Instructions updated for session ${sessionId} by ${req.session.username}`);

      res.json({ success: true, message: 'Instructions updated successfully' });
    } catch (error: unknown) {
      console.error('Failed to update instructions:', error);
      res.status(500).json({
        error: 'Failed to update instructions',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /admin/api/sideband/status - global sideband connection status
  router.get('/admin/api/sideband/status', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      const activeSessions = sidebandManager.getActiveConnections();

      let rows = await getActiveSidebandSessions();
      // Rows carry user_id, so therapist views filter directly against the
      // caseload — no per-row owner lookups.
      const scope = await therapistScopeId(req);
      if (scope !== null) {
        const clientIds = new Set(await getCaseloadClientIds(scope));
        // user_id rides along on the sideband row itself — no per-row lookups.
        rows = rows.filter(r => r.user_id !== null && r.user_id !== undefined && clientIds.has(Number(r.user_id)));
      }
      const sessions = rows.map(session => ({
        ...session,
        connection_active: activeSessions.includes(session.session_id as string),
      }));

      res.json({
        total_active_sessions: rows.length,
        sideband_connected_count: sessions.filter(s => s.connection_active).length,
        sessions,
      });
    } catch (error: unknown) {
      console.error('Failed to fetch sideband status:', error);
      res.status(500).json({
        error: 'Failed to fetch sideband status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /admin/api/sideband/update-session - update session config via sideband.
  // Accepts either a legacy `instructions` string or a full `config` object
  // (instructions, tools, tool_choice, temperature, turn_detection, ...).
  router.post('/admin/api/sideband/update-session', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId, instructions, config } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Missing required fields', details: 'sessionId is required' });
      }
      if (!(await therapistMayAccessSession(req, String(sessionId)))) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Build the update payload. A `config` object takes precedence; otherwise
      // fall back to the single-field `instructions` form.
      let updates: Record<string, unknown> | undefined;
      if (config && typeof config === 'object' && Object.keys(config).length > 0) {
        const cfg: Record<string, unknown> = { ...config };
        if (typeof cfg.instructions === 'string') cfg.instructions = cfg.instructions.trim();
        updates = cfg;
      } else if (typeof instructions === 'string' && instructions.trim()) {
        updates = { instructions: instructions.trim() };
      }

      if (!updates) {
        return res.status(400).json({ error: 'Missing required fields', details: 'Provide instructions or a non-empty config object' });
      }
      const payload = updates;

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');

      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection', details: 'Session must have an active sideband connection' });
      }

      await sidebandManager.updateSession(sessionId, payload);

      await logSidebandAction(sessionId, 'Session config updated via sideband', {
        admin_user: req.session.username,
        action: 'update_session',
        fields: Object.keys(payload),
      });

      res.json({ success: true, message: 'Session config updated successfully' });
    } catch (error: unknown) {
      console.error('Failed to update session via sideband:', error);
      res.status(500).json({
        error: 'Failed to update session',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /admin/api/sideband/interrupt - cancel the in-progress response + clear audio
  router.post('/admin/api/sideband/interrupt', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      if (!(await therapistMayAccessSession(req, String(sessionId)))) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.interrupt(sessionId);

      await logSidebandAction(sessionId, 'AI response interrupted via sideband', {
        admin_user: req.session.username,
        action: 'interrupt',
      });

      res.json({ success: true, message: 'Response interrupted' });
    } catch (error: unknown) {
      console.error('Failed to interrupt via sideband:', error);
      res.status(500).json({ error: 'Failed to interrupt', details: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /admin/api/sideband/inject - inject a system/user message into the live conversation
  router.post('/admin/api/sideband/inject', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId, text, role = 'system', respond = false } = req.body;
      if (!sessionId || !text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Missing required fields', details: 'sessionId and non-empty text are required' });
      }
      if (role !== 'system' && role !== 'user') {
        return res.status(400).json({ error: 'Invalid role', details: "role must be 'system' or 'user'" });
      }
      if (!(await therapistMayAccessSession(req, String(sessionId)))) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.injectMessage(sessionId, role, text.trim(), Boolean(respond));

      await logSidebandAction(sessionId, `Injected ${role} message via sideband`, {
        admin_user: req.session.username,
        action: 'inject_message',
        role,
        respond: Boolean(respond),
        text: text.trim(),
      });

      res.json({ success: true, message: 'Message injected' });
    } catch (error: unknown) {
      console.error('Failed to inject message via sideband:', error);
      res.status(500).json({ error: 'Failed to inject message', details: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /admin/api/sideband/respond - force the model to produce a response now
  router.post('/admin/api/sideband/respond', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId, response } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      if (!(await therapistMayAccessSession(req, String(sessionId)))) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.createResponse(sessionId, response && typeof response === 'object' ? response : undefined);

      await logSidebandAction(sessionId, 'Forced response via sideband', {
        admin_user: req.session.username,
        action: 'force_response',
        out_of_band: Boolean(response),
      });

      res.json({ success: true, message: 'Response triggered' });
    } catch (error: unknown) {
      console.error('Failed to force response via sideband:', error);
      res.status(500).json({ error: 'Failed to force response', details: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /admin/api/sideband/trigger-tool - force the model to call a specific
  // tool now (ai-therapist-103). Forces tool_choice to that function, injects
  // an invisible clinician nudge, triggers a response, and auto-resets
  // tool_choice back to 'auto' on the next response.done (30s fallback).
  // Server-side we refuse only unknown/disabled tools; sensitive tools like
  // end_session are confirm-gated client-side.
  router.post('/admin/api/sideband/trigger-tool', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId, toolName, args } = req.body;
      if (!sessionId || typeof toolName !== 'string' || !toolName.trim()) {
        return res.status(400).json({ error: 'Missing required fields', details: 'sessionId and toolName are required' });
      }
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return res.status(400).json({ error: 'Invalid args', details: 'args must be a JSON object when provided' });
      }
      if (!(await therapistMayAccessSession(req, String(sessionId)))) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { toolRegistry } = await import('../../services/toolRegistry.service.js');
      const enabled = await toolRegistry.getEnabledToolDefinitions();
      if (!enabled.some(def => def.name === toolName)) {
        return res.status(400).json({
          error: 'Unknown or disabled tool',
          details: `'${toolName}' is not an enabled tool`,
          available: enabled.map(def => def.name),
        });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');
      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection', details: 'Session must have an active sideband connection' });
      }

      await sidebandManager.triggerTool(sessionId, toolName, args as Record<string, unknown> | undefined);

      await logSidebandAction(sessionId, `Admin triggered tool ${toolName} via sideband`, {
        admin_user: req.session.username,
        action: 'trigger_tool',
        tool: toolName,
        args: args ?? null,
      });

      res.json({ success: true, message: `Tool ${toolName} triggered` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A response already in flight is a conflict, not a server fault: the
      // forced response.create would be rejected by OpenAI, so surface it
      // honestly instead of reporting success (or a generic 500).
      if (message.includes('conversation_already_has_active_response')) {
        return res.status(409).json({
          error: 'Model response in progress',
          details: 'The model is still responding; wait for the current response to finish and retry.',
        });
      }
      console.error('Failed to trigger tool via sideband:', error);
      res.status(500).json({ error: 'Failed to trigger tool', details: message });
    }
  });

  // POST /admin/api/sideband/disconnect - disconnect a sideband connection
  router.post('/admin/api/sideband/disconnect', requireRole('therapist', 'researcher'), async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Missing sessionId' });
      }
      if (!(await therapistMayAccessSession(req, String(sessionId)))) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { sidebandManager } = await import('../../services/sidebandManager.service.js');

      if (!sidebandManager.isConnected(sessionId)) {
        return res.status(400).json({ error: 'No active sideband connection for this session' });
      }

      await sidebandManager.disconnect(sessionId);

      await logSidebandAction(sessionId, 'Sideband connection manually disconnected', {
        admin_user: req.session.username,
        action: 'disconnect_sideband',
      });

      res.json({ success: true, message: 'Sideband connection disconnected successfully' });
    } catch (error: unknown) {
      console.error('Failed to disconnect sideband:', error);
      res.status(500).json({
        error: 'Failed to disconnect sideband connection',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
