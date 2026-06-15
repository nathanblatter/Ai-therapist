import { pool } from '../config/db.js';

// Scheduler state
let wipeInterval = null;
let nextScheduledWipe = null;

/**
 * Get content retention settings from database
 */
export async function getRetentionSettings() {
  try {
    const result = await pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'content_retention'`
    );
    if (result.rows.length === 0) {
      return getDefaultSettings();
    }
    return result.rows[0].config_value;
  } catch (err) {
    console.error('Failed to fetch retention settings:', err);
    return getDefaultSettings();
  }
}

function getDefaultSettings() {
  return {
    enabled: true,
    retention_hours: 24,
    wipe_time: '03:00',
    require_redaction_complete: true,
    last_wipe_at: null,
    last_wipe_count: 0
  };
}

/**
 * Update content retention settings
 */
export async function updateRetentionSettings(settings, updatedBy) {
  const result = await pool.query(
    `UPDATE system_config
     SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
     WHERE config_key = 'content_retention'
     RETURNING config_value`,
    [JSON.stringify(settings), updatedBy]
  );

  // Restart scheduler with new settings
  await startScheduler();

  return result.rows[0]?.config_value || settings;
}

/**
 * Execute content wipe operation
 * @param {string} triggeredBy - 'scheduler' or 'manual'
 * @param {string} triggeredByUser - Username if manual trigger
 * @returns {Object} Wipe result with counts
 */
export async function executeContentWipe(triggeredBy = 'scheduler', triggeredByUser = null) {
  const settings = await getRetentionSettings();

  // Create log entry
  const logResult = await pool.query(
    `INSERT INTO content_wipe_log (status, triggered_by, triggered_by_user, retention_hours)
     VALUES ('running', $1, $2, $3)
     RETURNING wipe_id`,
    [triggeredBy, triggeredByUser, settings.retention_hours]
  );
  const wipeId = logResult.rows[0].wipe_id;

  try {
    console.log(`🗑️ Starting content wipe (${triggeredBy})...`);

    // Calculate cutoff time based on retention hours
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - settings.retention_hours);

    // Build the wipe query based on settings
    let wipeQuery;
    let queryParams;

    if (settings.require_redaction_complete) {
      // Only wipe content where redaction is complete
      wipeQuery = `
        UPDATE messages
        SET content = NULL
        WHERE content IS NOT NULL
          AND content_redacted IS NOT NULL
          AND created_at < $1
          AND metadata->>'redaction_error' IS NULL
        RETURNING message_id
      `;
      queryParams = [cutoffTime];
    } else {
      // Wipe all content older than retention period (use with caution!)
      wipeQuery = `
        UPDATE messages
        SET content = NULL
        WHERE content IS NOT NULL
          AND created_at < $1
        RETURNING message_id
      `;
      queryParams = [cutoffTime];
    }

    // Execute the wipe
    const wipeResult = await pool.query(wipeQuery, queryParams);
    const messagesWiped = wipeResult.rowCount;

    // Count skipped messages (those with content but not wiped)
    const skippedResult = await pool.query(
      `SELECT COUNT(*) as count FROM messages
       WHERE content IS NOT NULL
         AND created_at < $1
         AND (content_redacted IS NULL OR metadata->>'redaction_error' IS NOT NULL)`,
      [cutoffTime]
    );
    const messagesSkipped = parseInt(skippedResult.rows[0].count);

    // Update log entry
    await pool.query(
      `UPDATE content_wipe_log
       SET completed_at = CURRENT_TIMESTAMP,
           messages_wiped = $1,
           messages_skipped = $2,
           status = 'completed'
       WHERE wipe_id = $3`,
      [messagesWiped, messagesSkipped, wipeId]
    );

    // Update last wipe info in settings
    const updatedSettings = {
      ...settings,
      last_wipe_at: new Date().toISOString(),
      last_wipe_count: messagesWiped
    };
    await pool.query(
      `UPDATE system_config
       SET config_value = $1, updated_at = CURRENT_TIMESTAMP
       WHERE config_key = 'content_retention'`,
      [JSON.stringify(updatedSettings)]
    );

    console.log(`✅ Content wipe completed: ${messagesWiped} messages wiped, ${messagesSkipped} skipped`);

    // Emit socket event to notify admins
    if (global.io) {
      global.io.to('admin').emit('content:wiped', {
        wipeId,
        messagesWiped,
        messagesSkipped,
        triggeredBy,
        completedAt: new Date().toISOString()
      });
    }

    return {
      success: true,
      wipeId,
      messagesWiped,
      messagesSkipped
    };

  } catch (error) {
    console.error('Content wipe failed:', error);

    // Update log entry with error
    await pool.query(
      `UPDATE content_wipe_log
       SET completed_at = CURRENT_TIMESTAMP,
           status = 'failed',
           error_message = $1
       WHERE wipe_id = $2`,
      [error.message, wipeId]
    );

    return {
      success: false,
      wipeId,
      error: error.message
    };
  }
}

/**
 * Get wipe statistics and pending content info
 */
export async function getWipeStats() {
  const settings = await getRetentionSettings();

  // Get pending wipe count (messages that would be wiped now)
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - settings.retention_hours);

  const pendingResult = await pool.query(
    `SELECT COUNT(*) as count FROM messages
     WHERE content IS NOT NULL
       AND content_redacted IS NOT NULL
       AND created_at < $1
       AND metadata->>'redaction_error' IS NULL`,
    [cutoffTime]
  );

  // Get messages awaiting redaction
  const awaitingRedactionResult = await pool.query(
    `SELECT COUNT(*) as count FROM messages
     WHERE content IS NOT NULL
       AND content_redacted IS NULL`
  );

  // Get messages with redaction errors
  const redactionErrorsResult = await pool.query(
    `SELECT COUNT(*) as count FROM messages
     WHERE content IS NOT NULL
       AND metadata->>'redaction_error' IS NOT NULL`
  );

  // Get total messages with original content still present
  const totalWithContentResult = await pool.query(
    `SELECT COUNT(*) as count FROM messages WHERE content IS NOT NULL`
  );

  // Get recent wipe log
  const recentWipesResult = await pool.query(
    `SELECT * FROM content_wipe_log
     ORDER BY started_at DESC
     LIMIT 10`
  );

  return {
    settings,
    stats: {
      pending_wipe: parseInt(pendingResult.rows[0].count),
      awaiting_redaction: parseInt(awaitingRedactionResult.rows[0].count),
      redaction_errors: parseInt(redactionErrorsResult.rows[0].count),
      total_with_content: parseInt(totalWithContentResult.rows[0].count)
    },
    recent_wipes: recentWipesResult.rows,
    next_scheduled_wipe: nextScheduledWipe?.toISOString() || null
  };
}

/**
 * Parse time string (HH:MM) and calculate next occurrence
 */
function getNextWipeTime(wipeTimeStr) {
  const [hours, minutes] = wipeTimeStr.split(':').map(Number);
  const now = new Date();
  const next = new Date();

  next.setHours(hours, minutes, 0, 0);

  // If the time has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

/**
 * Calculate milliseconds until next wipe time
 */
function getMillisecondsUntilWipe(wipeTimeStr) {
  const next = getNextWipeTime(wipeTimeStr);
  return next.getTime() - Date.now();
}

/**
 * Schedule the next wipe and set up recurring schedule
 */
async function scheduleNextWipe() {
  const settings = await getRetentionSettings();

  if (!settings.enabled) {
    console.log('📅 Content wipe scheduler disabled');
    nextScheduledWipe = null;
    return;
  }

  const msUntilWipe = getMillisecondsUntilWipe(settings.wipe_time);
  nextScheduledWipe = getNextWipeTime(settings.wipe_time);

  console.log(`📅 Next content wipe scheduled for ${nextScheduledWipe.toISOString()}`);

  // Clear any existing timeout
  if (wipeInterval) {
    clearTimeout(wipeInterval);
  }

  // Schedule the wipe
  wipeInterval = setTimeout(async () => {
    await executeContentWipe('scheduler');
    // Schedule the next one
    scheduleNextWipe();
  }, msUntilWipe);
}

/**
 * Start the content wipe scheduler
 */
export async function startScheduler() {
  console.log('🚀 Starting content wipe scheduler...');
  await scheduleNextWipe();
}

/**
 * Stop the scheduler
 */
export function stopScheduler() {
  if (wipeInterval) {
    clearTimeout(wipeInterval);
    wipeInterval = null;
    nextScheduledWipe = null;
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    running: wipeInterval !== null,
    nextScheduledWipe: nextScheduledWipe?.toISOString() || null
  };
}
