// Retention/deletion automation (ai-therapist-97). Deliberately parallel to
// contentWipe.service.ts: settings live in system_config.data_retention, a
// setTimeout scheduler fires at run_time, every deletion writes a
// data_deletion_log row, and there is a manual trigger. Ships DISABLED.
//
// Three enforcement rules per pass (one run_id):
//   1. recording age-out   — recordings older than recordings_retention_days
//   2. wiped-user grace     — orphaned (user_id IS NULL) ended sessions past
//                             wiped_user_grace_days get their recording deleted
//   3. message age-out      — thread messages (and their message-origin
//                             crisis_events) older than the SAME
//                             recordings_retention_days window are hard-deleted
//                             (caseworker portal spec section 10 item 8:
//                             messages retain like sessions; sandbox exempt)
// MinIO delete is best-effort-first (same ordering as demoCleanup.service): the
// object is removed before the DB columns are nulled, and a MinIO failure logs
// success=false and leaves the columns intact for retry next run.
import { randomUUID } from 'node:crypto';
import { pool } from '../config/db.js';
import { deleteObject } from '../config/objectStorage.js';
import {
  getRecordingsToAgeOut,
  getOrphanedRecordingsPastGrace,
  clearRecordingColumns,
  insertDeletionLog,
  type RecordingRow,
} from '../db/dataRetention.queries.js';
import { deleteAgedThreadMessages } from '../db/messagingRetention.queries.js';

export interface DataRetentionSettings {
  enabled: boolean;
  recordings_retention_days: number;
  wiped_user_grace_days: number;
  run_time: string; // HH:MM
  last_run_at: string | null;
  last_run_deletions: number;
}

export interface RetentionRunResult {
  runId: string;
  recordingsDeleted: number;
  graceDeleted: number;
  threadMessagesDeleted: number;
  failures: number;
  skipped: boolean; // true when the job is disabled
}

const DEFAULT_SETTINGS: DataRetentionSettings = {
  enabled: false,
  recordings_retention_days: 90,
  wiped_user_grace_days: 14,
  run_time: '03:30',
  last_run_at: null,
  last_run_deletions: 0,
};

let retentionTimeout: ReturnType<typeof setTimeout> | null = null;
let nextScheduledRun: Date | null = null;

export async function getDataRetentionSettings(): Promise<DataRetentionSettings> {
  try {
    const result = await pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'data_retention'`
    );
    if (result.rows.length === 0) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(result.rows[0].config_value as Partial<DataRetentionSettings>) };
  } catch (err) {
    console.error('Failed to fetch data retention settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateDataRetentionSettings(
  settings: DataRetentionSettings,
  _updatedBy: string
): Promise<DataRetentionSettings> {
  const result = await pool.query(
    `UPDATE system_config
        SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
      WHERE config_key = 'data_retention'
      RETURNING config_value`,
    [JSON.stringify(settings), _updatedBy]
  );
  await startScheduler(); // restart with new run_time / enabled
  return (result.rows[0]?.config_value as DataRetentionSettings) ?? settings;
}

/**
 * Delete one recording object (MinIO first, then DB columns) and append the
 * audit row. On MinIO failure the DB columns are left intact and the row is
 * logged with success=false so the next run retries.
 */
async function deleteRecording(
  row: RecordingRow,
  reason: 'recording_retention' | 'wiped_user_grace',
  runId: string,
  settings: DataRetentionSettings,
  triggeredBy: 'scheduler' | 'manual',
  triggeredByUser: string | null
): Promise<boolean> {
  try {
    await deleteObject(row.recording_object_key);
    await clearRecordingColumns(row.session_id);
    await insertDeletionLog({
      runId, artifactType: 'recording_object', artifactRef: row.recording_object_key,
      sessionId: row.session_id, userId: row.user_id, reason, policySnapshot: settings,
      triggeredBy, triggeredByUser, success: true, errorMessage: null,
    });
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Retention] failed to delete recording ${row.recording_object_key}:`, errorMessage);
    await insertDeletionLog({
      runId, artifactType: 'recording_object', artifactRef: row.recording_object_key,
      sessionId: row.session_id, userId: row.user_id, reason, policySnapshot: settings,
      triggeredBy, triggeredByUser, success: false, errorMessage,
    }).catch(logErr => console.error('[Retention] failed to write deletion log:', logErr));
    return false;
  }
}

/**
 * Enforce all retention rules in one pass (one run_id).
 *
 * Sandbox exemption (caseworker portal spec section 7 / decision 10) is
 * structural here — verified, no extra filter needed: both selection queries
 * in dataRetention.queries.ts already exclude `is_demo` sessions, and every
 * sandbox-seeded session is created with is_demo=TRUE (and never has a
 * recording in the first place). If a non-is_demo sandbox artifact ever
 * appears, add a users.is_sandbox guard alongside the is_demo one there.
 * The message age-out (rule 3) carries its own explicit sandbox filters in
 * messagingRetention.queries.ts (threads are not sessions, so is_demo does
 * not cover them).
 */
export async function enforceRetention(
  triggeredBy: 'scheduler' | 'manual',
  triggeredByUser?: string
): Promise<RetentionRunResult> {
  const settings = await getDataRetentionSettings();
  const runId = randomUUID();

  if (!settings.enabled && triggeredBy === 'scheduler') {
    return { runId, recordingsDeleted: 0, graceDeleted: 0, threadMessagesDeleted: 0, failures: 0, skipped: true };
  }

  let recordingsDeleted = 0;
  let graceDeleted = 0;
  let threadMessagesDeleted = 0;
  let failures = 0;

  // 1. Recording age-out.
  const ageOut = await getRecordingsToAgeOut(settings.recordings_retention_days);
  for (const row of ageOut) {
    const ok = await deleteRecording(row, 'recording_retention', runId, settings, triggeredBy, triggeredByUser ?? null);
    if (ok) recordingsDeleted++; else failures++;
  }

  // 2. Wiped-user grace (orphaned ended sessions past grace). Skip any already
  // handled in rule 1 to avoid double work within the same pass.
  const handled = new Set(ageOut.map(r => r.session_id));
  const grace = await getOrphanedRecordingsPastGrace(settings.wiped_user_grace_days);
  for (const row of grace) {
    if (handled.has(row.session_id)) continue;
    const ok = await deleteRecording(row, 'wiped_user_grace', runId, settings, triggeredBy, triggeredByUser ?? null);
    if (ok) graceDeleted++; else failures++;
  }

  // 3. Message age-out (caseworker portal spec section 10 item 8: messages
  // retain like sessions). Thread messages older than the SAME
  // recordings_retention_days window are hard-deleted, message-origin
  // crisis_events first (FK order), sandbox threads exempt (item 10). The
  // data_deletion_log audit row shares the deletion transaction, so a failed
  // audit insert (e.g. data_deletion_log CHECKs not yet widened by migration)
  // rolls the whole deletion back — messages are never deleted unaudited.
  try {
    const messageResult = await deleteAgedThreadMessages({
      days: settings.recordings_retention_days,
      runId,
      policySnapshot: settings,
      triggeredBy,
      triggeredByUser: triggeredByUser ?? null,
    });
    threadMessagesDeleted = messageResult.messagesDeleted;
  } catch (err) {
    failures++;
    console.error('[Retention] thread-message age-out failed (rolled back, retried next run):', err);
  }

  const totalDeletions = recordingsDeleted + graceDeleted + threadMessagesDeleted;
  const updated: DataRetentionSettings = {
    ...settings,
    last_run_at: new Date().toISOString(),
    last_run_deletions: totalDeletions,
  };
  await pool.query(
    `UPDATE system_config SET config_value = $1, updated_at = CURRENT_TIMESTAMP
      WHERE config_key = 'data_retention'`,
    [JSON.stringify(updated)]
  ).catch(err => console.error('[Retention] failed to stamp last_run:', err));

  console.log(`[Retention] run ${runId}: ${recordingsDeleted} aged-out, ${graceDeleted} grace, ${threadMessagesDeleted} thread messages, ${failures} failures`);
  return { runId, recordingsDeleted, graceDeleted, threadMessagesDeleted, failures, skipped: false };
}

function getNextRunTime(runTime: string): Date {
  const [hours, minutes] = runTime.split(':').map(Number);
  const next = new Date();
  next.setHours(hours || 0, minutes || 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next;
}

async function scheduleNextRun(): Promise<void> {
  const settings = await getDataRetentionSettings();
  if (retentionTimeout) {
    clearTimeout(retentionTimeout);
    retentionTimeout = null;
  }
  if (!settings.enabled) {
    console.log('📅 Data retention scheduler disabled');
    nextScheduledRun = null;
    return;
  }
  nextScheduledRun = getNextRunTime(settings.run_time);
  const ms = nextScheduledRun.getTime() - Date.now();
  console.log(`📅 Next data retention run scheduled for ${nextScheduledRun.toISOString()}`);
  retentionTimeout = setTimeout(async () => {
    await enforceRetention('scheduler').catch(err => console.error('[Retention] scheduled run failed:', err));
    // Daily, idempotent study-ops anomaly scan piggybacks on this tick.
    try {
      const { scanForDeviations } = await import('../db/studyOps.queries.js');
      await scanForDeviations();
    } catch (err) {
      console.error('[Retention] deviation scan failed:', err);
    }
    scheduleNextRun();
  }, ms);
  retentionTimeout.unref?.();
}

/** Start the retention scheduler. Wire in index.ts next to startContentWipeScheduler(). */
export async function startScheduler(): Promise<void> {
  console.log('🚀 Starting data retention scheduler...');
  await scheduleNextRun();
}

export function stopScheduler(): void {
  if (retentionTimeout) {
    clearTimeout(retentionTimeout);
    retentionTimeout = null;
    nextScheduledRun = null;
  }
}

export function getSchedulerStatus(): { running: boolean; nextScheduledRun: string | null } {
  return { running: retentionTimeout !== null, nextScheduledRun: nextScheduledRun?.toISOString() ?? null };
}
