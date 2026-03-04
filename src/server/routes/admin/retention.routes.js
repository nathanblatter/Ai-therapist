import { Router } from 'express';
import { pool } from '../../config/db.js';
import { requireRole } from '../../middleware/auth.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createLogger } from '../../utils/logger.js';
import {
  getRetentionSettings,
  updateRetentionSettings,
  executeContentWipe,
  getWipeStats,
  getSchedulerStatus
} from '../../services/contentWipe.service.js';

const log = createLogger('admin:retention');

export default function adminRetentionRoutes() {
  const router = Router();

  // GET /admin/api/content-retention - Get stats and scheduler status
  router.get('/admin/api/content-retention', requireRole('researcher'), asyncHandler(async (req, res) => {
    log.info('Fetching content retention settings');

    const settings = await getRetentionSettings();
    const stats = await getWipeStats();
    const schedulerStatus = await getSchedulerStatus();

    res.json({
      settings,
      stats,
      scheduler: schedulerStatus
    });
  }));

  // PUT /admin/api/content-retention - Update settings
  router.put('/admin/api/content-retention', requireRole('researcher'), asyncHandler(async (req, res) => {
    const { enabled, retention_hours, wipe_time, require_redaction_complete } = req.body;
    const adminUsername = req.session.username;

    log.info({ adminUsername, settings: req.body }, 'Updating content retention settings');

    // Validate inputs
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    if (retention_hours !== undefined) {
      const hours = parseInt(retention_hours);
      if (isNaN(hours) || hours < 1 || hours > 8760) {
        return res.status(400).json({
          error: 'retention_hours must be between 1 and 8760 (1 year)'
        });
      }
    }

    if (wipe_time !== undefined) {
      // Validate HH:MM format
      const timeRegex = /^([0-1][0-9]|2[0-3]):([0-5][0-9])$/;
      if (!timeRegex.test(wipe_time)) {
        return res.status(400).json({
          error: 'wipe_time must be in HH:MM format (24-hour)'
        });
      }
    }

    if (require_redaction_complete !== undefined && typeof require_redaction_complete !== 'boolean') {
      return res.status(400).json({ error: 'require_redaction_complete must be a boolean' });
    }

    // Get current settings
    const currentSettings = await getRetentionSettings();

    // Merge with new settings
    const updatedSettings = {
      ...currentSettings,
      enabled,
      retention_hours: retention_hours !== undefined ? parseInt(retention_hours) : currentSettings.retention_hours,
      wipe_time: wipe_time || currentSettings.wipe_time,
      require_redaction_complete: require_redaction_complete !== undefined ? require_redaction_complete : currentSettings.require_redaction_complete
    };

    // Save settings
    const result = await updateRetentionSettings(updatedSettings, adminUsername);

    log.info({ adminUsername, settings: result }, 'Content retention settings updated');

    res.json({
      success: true,
      settings: result,
      message: 'Content retention settings updated'
    });
  }));

  // POST /admin/api/content-retention/wipe - Trigger manual wipe
  router.post('/admin/api/content-retention/wipe', requireRole('researcher'), asyncHandler(async (req, res) => {
    const adminUsername = req.session.username;

    log.info({ adminUsername }, 'Manual content wipe triggered');

    // Execute wipe
    const result = await executeContentWipe('manual', adminUsername);

    log.info({ adminUsername, result }, 'Manual content wipe completed');

    res.json({
      success: true,
      ...result,
      message: 'Content wipe completed'
    });
  }));

  // GET /admin/api/content-retention/log - Get wipe history with pagination
  router.get('/admin/api/content-retention/log', requireRole('researcher'), asyncHandler(async (req, res) => {
    const { page = '1', limit = '50' } = req.query;

    log.info({ page, limit }, 'Fetching content wipe log');

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get wipe history
    const result = await pool.query(
      `SELECT
        wipe_id,
        status,
        triggered_by,
        triggered_by_user,
        retention_hours,
        messages_wiped,
        started_at,
        completed_at,
        error_message
      FROM content_wipe_log
      ORDER BY started_at DESC
      LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    );

    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) as total FROM content_wipe_log');
    const total = parseInt(countResult.rows[0].total);

    res.json({
      wipes: result.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  }));

  return router;
}
