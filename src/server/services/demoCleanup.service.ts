// Demo-account expiry sweep. Every magic-link visitor mints a throwaway
// demo_<hex> user (users.role='demo') whose therapy sessions write real rows
// (messages, configs, recordings in MinIO). Nothing else ever deletes them, so
// this service sweeps demo users older than DEMO_MAX_AGE_DAYS once a day:
// recordings first (best-effort), then sessions (cascades messages/configs/
// insights/crisis rows), then the user row (cascades user_memories etc.).
//
// Sessions are deleted explicitly before the user because therapy_sessions.
// user_id is ON DELETE SET NULL — deleting the user first would orphan the
// sessions as "anonymous" instead of removing them.
//
// Like contentWipe, this service holds its own queries by design.
import { pool } from '../config/db.js';
import { deleteObject } from '../config/objectStorage.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('demoCleanup');

const DEMO_MAX_AGE_DAYS = parseInt(process.env.DEMO_MAX_AGE_DAYS || '7', 10);
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let sweepTimer: NodeJS.Timeout | null = null;

export interface DemoCleanupResult {
  usersDeleted: number;
  sessionsDeleted: number;
  recordingsDeleted: number;
}

/** Delete demo users (and everything they own) older than maxAgeDays. */
export async function runDemoCleanup(maxAgeDays = DEMO_MAX_AGE_DAYS): Promise<DemoCleanupResult> {
  const expired = await pool.query<{ userid: number }>(
    `SELECT userid FROM users
     WHERE role = 'demo' AND created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [maxAgeDays]
  );
  const userIds = expired.rows.map(r => r.userid);
  if (userIds.length === 0) {
    return { usersDeleted: 0, sessionsDeleted: 0, recordingsDeleted: 0 };
  }

  // Best-effort recording deletion: a MinIO failure must not strand the DB
  // sweep, and a dangling object is cheaper than a dangling PHI-shaped row.
  const recordings = await pool.query<{ recording_object_key: string }>(
    `SELECT recording_object_key FROM therapy_sessions
     WHERE user_id = ANY($1) AND recording_object_key IS NOT NULL`,
    [userIds]
  );
  let recordingsDeleted = 0;
  for (const { recording_object_key } of recordings.rows) {
    try {
      await deleteObject(recording_object_key);
      recordingsDeleted++;
    } catch (err) {
      log.error({ err }, `Failed to delete demo recording ${recording_object_key}`);
    }
  }

  const sessions = await pool.query(
    'DELETE FROM therapy_sessions WHERE user_id = ANY($1)',
    [userIds]
  );
  const users = await pool.query(
    'DELETE FROM users WHERE userid = ANY($1)',
    [userIds]
  );

  const result: DemoCleanupResult = {
    usersDeleted: users.rowCount ?? 0,
    sessionsDeleted: sessions.rowCount ?? 0,
    recordingsDeleted,
  };
  log.info(
    `Swept ${result.usersDeleted} expired demo users ` +
    `(${result.sessionsDeleted} sessions, ${result.recordingsDeleted} recordings, >${maxAgeDays}d old)`
  );
  return result;
}

/** Run one sweep now, then daily. Failures log and retry next interval. */
export function startDemoCleanupScheduler(): void {
  runDemoCleanup().catch(err => log.error({ err }, 'Demo cleanup sweep failed'));
  sweepTimer = setInterval(() => {
    runDemoCleanup().catch(err => log.error({ err }, 'Demo cleanup sweep failed'));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopDemoCleanupScheduler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
