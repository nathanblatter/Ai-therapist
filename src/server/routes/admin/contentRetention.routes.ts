// Admin content-retention / data-wipe endpoints (researcher only).
import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  updateRetentionSettings,
  executeContentWipe,
  getWipeStats,
  getSchedulerStatus,
} from '../../services/contentWipe.service.js';
import { getContentWipeLog } from '../../db/index.js';

export default function contentRetentionRoutes(): Router {
  const router = Router();

  // GET /admin/api/content-retention - settings + stats
  router.get('/admin/api/content-retention', requireRole('researcher'), async (_req, res) => {
    try {
      const stats = await getWipeStats();
      const schedulerStatus = getSchedulerStatus();
      res.json({ ...stats, scheduler: schedulerStatus });
    } catch (err) {
      console.error('Failed to fetch content retention stats:', err);
      res.status(500).json({ error: 'Failed to fetch content retention stats' });
    }
  });

  // PUT /admin/api/content-retention - update settings
  router.put('/admin/api/content-retention', requireRole('researcher'), async (req, res) => {
    const { settings } = req.body;

    if (!settings) {
      return res.status(400).json({ error: 'Settings are required' });
    }
    if (typeof settings.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (typeof settings.retention_hours !== 'number' || settings.retention_hours < 1 || settings.retention_hours > 8760) {
      return res.status(400).json({ error: 'retention_hours must be between 1 and 8760 (1 year)' });
    }
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(settings.wipe_time)) {
      return res.status(400).json({ error: 'wipe_time must be in HH:MM format' });
    }
    if (typeof settings.require_redaction_complete !== 'boolean') {
      return res.status(400).json({ error: 'require_redaction_complete must be a boolean' });
    }

    try {
      const updatedSettings = await updateRetentionSettings(settings, req.session.username!);
      res.json({ success: true, settings: updatedSettings });
    } catch (err) {
      console.error('Failed to update content retention settings:', err);
      res.status(500).json({ error: 'Failed to update content retention settings' });
    }
  });

  // POST /admin/api/content-retention/wipe - trigger a manual wipe
  router.post('/admin/api/content-retention/wipe', requireRole('researcher'), async (req, res) => {
    try {
      const result = await executeContentWipe('manual', req.session.username);
      if (result.success) {
        res.json({
          success: true,
          wipeId: result.wipeId,
          messagesWiped: result.messagesWiped,
          messagesSkipped: result.messagesSkipped,
        });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (err) {
      console.error('Failed to execute content wipe:', err);
      res.status(500).json({ error: 'Failed to execute content wipe' });
    }
  });

  // GET /admin/api/content-retention/log - wipe history
  router.get('/admin/api/content-retention/log', requireRole('researcher'), async (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '')) || 50;
    const offset = parseInt(String(req.query.offset ?? '')) || 0;

    try {
      const { wipes, total } = await getContentWipeLog(limit, offset);
      res.json({ wipes, total, limit, offset });
    } catch (err) {
      console.error('Failed to fetch content wipe log:', err);
      res.status(500).json({ error: 'Failed to fetch content wipe log' });
    }
  });

  return router;
}
