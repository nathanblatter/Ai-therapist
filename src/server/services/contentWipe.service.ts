import { pool } from '../config/db.js';
import { wipeAgedThreadMessageBodies } from '../db/messagingRetention.queries.js';
import { broadcastAdminEvent } from '../utils/adminBroadcast.js';

// Scheduler state
let wipeInterval: ReturnType<typeof setTimeout> | null = null;
let nextScheduledWipe: Date | null = null;

// Redaction-gap sweep (ai-therapist-22): a session's /end handler fires
// redactSession() as a fire-and-forget job, but a message can still be
// mid-flight (a late /logs/batch flush from the client, landing after /end
// already ran) and insert AFTER that batch job already queried "unredacted
// messages for this session". That message is then stuck with content set and
// content_redacted NULL forever — invisible until someone opens the session in
// the admin transcript view. This sweep runs independently of the wipe and
// just re-invokes the same idempotent redactSession() for any ended session
// that still has redaction gaps, so nothing needs deployment-day glue: the
// wipe query already protects unredacted content from being wiped
// (content_redacted IS NOT NULL is required), so nothing is lost while a gap
// waits for the next sweep tick.
let redactionSweepInterval: ReturnType<typeof setInterval> | null = null;
const REDACTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface RetentionSettings {
  enabled: boolean;
  retention_hours: number;
  wipe_time: string;
  require_redaction_complete: boolean;
  last_wipe_at: string | null;
  last_wipe_count: number;
}

/**
 * Get content retention settings from database
 */
export async function getRetentionSettings(): Promise<RetentionSettings> {
  try {
    const result = await pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'content_retention'`
    );
    if (result.rows.length === 0) {
      return getDefaultSettings();
    }
    return result.rows[0].config_value as RetentionSettings;
  } catch (err) {
    console.error('Failed to fetch retention settings:', err);
    return getDefaultSettings();
  }
}

function getDefaultSettings(): RetentionSettings {
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
export async function updateRetentionSettings(settings: RetentionSettings, updatedBy: string): Promise<RetentionSettings> {
  const result = await pool.query(
    `UPDATE system_config
     SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
     WHERE config_key = 'content_retention'
     RETURNING config_value`,
    [JSON.stringify(settings), updatedBy]
  );

  // Restart scheduler with new settings
  await startScheduler();

  return (result.rows[0]?.config_value as RetentionSettings) || settings;
}

/**
 * Execute content wipe operation
 * @param {string} triggeredBy - 'scheduler' or 'manual'
 * @param {string} triggeredByUser - Username if manual trigger
 * @returns {Object} Wipe result with counts
 */
export async function executeContentWipe(triggeredBy = 'scheduler', triggeredByUser: string | null = null): Promise<{
  success: boolean;
  wipeId: unknown;
  messagesWiped?: number | null;
  messagesSkipped?: number;
  threadBodiesWiped?: number;
  error?: string;
}> {
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

    // NOTE (ai-therapist-95, IRB): this wipe only nulls messages.content. The
    // REDACTED transcript excerpts snapshotted into adverse_event_reports
    // (transcript_excerpt) are deliberately NOT swept here — filed AE reports
    // are IRB regulatory records and are exempt from the content-retention
    // wipe. They contain redacted-only text (no raw PHI), so retaining them is
    // safe; do not add adverse_event_reports to this sweep.
    //
    // Sandbox exemption (caseworker portal spec section 7 / decision 10):
    // sandbox-org transcripts are synthetic fixtures with no PHI, seeded once
    // and retained until researcher-triggered batch teardown — a wiped
    // sandbox is a broken demo. Everything owned by an is_sandbox account is
    // excluded from the wipe.
    const notSandboxClause = `
          AND NOT EXISTS (
            SELECT 1 FROM therapy_sessions sbx
            JOIN users sbxu ON sbxu.userid = sbx.user_id
            WHERE sbx.session_id = messages.session_id AND sbxu.is_sandbox
          )`;
    let wipeQuery: string;
    let queryParams: unknown[];

    if (settings.require_redaction_complete) {
      // Only wipe content where redaction is complete
      wipeQuery = `
        UPDATE messages
        SET content = NULL
        WHERE content IS NOT NULL
          AND content_redacted IS NOT NULL
          AND created_at < $1
          AND metadata->>'redaction_error' IS NULL${notSandboxClause}
        RETURNING message_id
      `;
      queryParams = [cutoffTime];
    } else {
      // Wipe all content older than retention period (use with caution!)
      wipeQuery = `
        UPDATE messages
        SET content = NULL
        WHERE content IS NOT NULL
          AND created_at < $1${notSandboxClause}
        RETURNING message_id
      `;
      queryParams = [cutoffTime];
    }

    // Execute the wipe
    const wipeResult = await pool.query(wipeQuery, queryParams);
    const messagesWiped = wipeResult.rowCount;

    // Thread-message inclusion (caseworker portal spec section 10 item 8:
    // messages retain like sessions). Same cutoff clock: async thread message
    // BODIES are blanked; the row and its scan signals survive until the
    // dataRetention sweep hard-deletes them at the end of the retention
    // window. require_redaction_complete's analog here is "scan settled":
    // scan_status='pending' messages are left for the next run. Sandbox
    // threads are exempt inside the query (spec section 10 item 10).
    const threadBodiesWiped = await wipeAgedThreadMessageBodies(
      cutoffTime,
      settings.require_redaction_complete
    );

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
    const updatedSettings: RetentionSettings = {
      ...settings,
      last_wipe_at: new Date().toISOString(),
      last_wipe_count: messagesWiped ?? 0
    };
    await pool.query(
      `UPDATE system_config
       SET config_value = $1, updated_at = CURRENT_TIMESTAMP
       WHERE config_key = 'content_retention'`,
      [JSON.stringify(updatedSettings)]
    );

    console.log(`✅ Content wipe completed: ${messagesWiped} messages wiped, ${messagesSkipped} skipped, ${threadBodiesWiped} thread message bodies wiped`);

    // Notify admin dashboards. Through broadcastAdminEvent with no participant
    // linkage -> researcher room only (the old hand-rolled emit targeted a
    // room named 'admin' that no socket ever joins, so it was never delivered).
    if (global.io) {
      void broadcastAdminEvent(global.io, 'content:wiped', {
        wipeId,
        messagesWiped,
        messagesSkipped,
        threadBodiesWiped,
        triggeredBy,
        completedAt: new Date().toISOString()
      }, null);
    }

    return {
      success: true,
      wipeId,
      messagesWiped,
      messagesSkipped,
      threadBodiesWiped
    };

  } catch (error: unknown) {
    console.error('Content wipe failed:', error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Update log entry with error
    await pool.query(
      `UPDATE content_wipe_log
       SET completed_at = CURRENT_TIMESTAMP,
           status = 'failed',
           error_message = $1
       WHERE wipe_id = $2`,
      [errorMessage, wipeId]
    );

    return {
      success: false,
      wipeId,
      error: errorMessage
    };
  }
}

/**
 * Get wipe statistics and pending content info
 */
export async function getWipeStats(): Promise<Record<string, unknown>> {
  const settings = await getRetentionSettings();

  // Get pending wipe count (messages that would be wiped now)
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - settings.retention_hours);

  // Mirrors the wipe query's sandbox exemption so the "pending" stat never
  // counts messages the wipe will deliberately skip forever.
  const pendingResult = await pool.query(
    `SELECT COUNT(*) as count FROM messages
     WHERE content IS NOT NULL
       AND content_redacted IS NOT NULL
       AND created_at < $1
       AND metadata->>'redaction_error' IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM therapy_sessions sbx
         JOIN users sbxu ON sbxu.userid = sbx.user_id
         WHERE sbx.session_id = messages.session_id AND sbxu.is_sandbox
       )`,
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
function getNextWipeTime(wipeTimeStr: string): Date {
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
function getMillisecondsUntilWipe(wipeTimeStr: string): number {
  const next = getNextWipeTime(wipeTimeStr);
  return next.getTime() - Date.now();
}

/**
 * Schedule the next wipe and set up recurring schedule
 */
async function scheduleNextWipe(): Promise<void> {
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
 * Find ended sessions that still have a message with content set but
 * content_redacted NULL — a redaction gap (ai-therapist-22). Exported
 * separately from the sweep runner so the query logic can be unit tested
 * without mocking the redaction service.
 */
export async function findEndedSessionsWithRedactionGaps(limit = 200): Promise<string[]> {
  // Sandbox sessions are excluded belt-and-suspenders: the seeder always
  // stamps content_redacted, and the LLM redactor must never run over
  // synthetic fixture transcripts (cost + retained-forever demo data).
  const result = await pool.query<{ session_id: string }>(
    `SELECT DISTINCT ts.session_id
       FROM therapy_sessions ts
       JOIN messages m ON m.session_id = ts.session_id
       LEFT JOIN users u ON u.userid = ts.user_id
      WHERE ts.status = 'ended'
        AND m.content IS NOT NULL
        AND m.content_redacted IS NULL
        AND m.role IN ('user', 'assistant')
        AND u.is_sandbox IS NOT TRUE
      LIMIT $1`,
    [limit]
  );
  return result.rows.map(r => r.session_id);
}

/**
 * Re-run the (idempotent) per-session batched redaction job for every ended
 * session with a gap. Safe to call repeatedly / concurrently with itself —
 * redactSession only touches rows that are still unredacted.
 */
export async function sweepRedactionGaps(): Promise<{ sweptSessions: number }> {
  const sessionIds = await findEndedSessionsWithRedactionGaps();
  if (sessionIds.length === 0) return { sweptSessions: 0 };

  console.log(`🔁 Redaction sweep: re-running redactSession for ${sessionIds.length} ended session(s) with gaps`);
  const { redactSession } = await import('./sessionRedaction.service.js');
  for (const sessionId of sessionIds) {
    await redactSession(sessionId).catch(err =>
      console.error(`[Redaction sweep] failed for ${sessionId}:`, err)
    );
  }
  return { sweptSessions: sessionIds.length };
}

/**
 * Start the content wipe scheduler
 */
export async function startScheduler(): Promise<void> {
  console.log('🚀 Starting content wipe scheduler...');
  await scheduleNextWipe();

  if (!redactionSweepInterval) {
    redactionSweepInterval = setInterval(() => {
      sweepRedactionGaps().catch(err => console.error('[Redaction sweep] tick failed:', err));
    }, REDACTION_SWEEP_INTERVAL_MS);
    redactionSweepInterval.unref?.();
    // Run once immediately rather than waiting a full interval after boot/restart.
    sweepRedactionGaps().catch(err => console.error('[Redaction sweep] initial run failed:', err));
  }
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (wipeInterval) {
    clearTimeout(wipeInterval);
    wipeInterval = null;
    nextScheduledWipe = null;
  }
  if (redactionSweepInterval) {
    clearInterval(redactionSweepInterval);
    redactionSweepInterval = null;
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): { running: boolean; nextScheduledWipe: string | null } {
  return {
    running: wipeInterval !== null,
    nextScheduledWipe: nextScheduledWipe?.toISOString() || null
  };
}
