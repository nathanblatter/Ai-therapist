// Finalizes sessions the participant never cleanly /end'd — a dropped tunnel
// connection, a closed tab, or a crashed browser all leave a session sitting
// "active" forever with its recording unfinalized and its content unredacted.
//
// Two triggers feed the same finalize path:
//  1. Fast path: the participant's socket disconnects while joined to a
//     session room. The socket is known to be flaky through the Cloudflare
//     tunnel (see ai-therapist-18), so a bare disconnect is NOT treated as
//     abandonment — a short grace window gives a reconnect (or a fresh
//     audio chunk, which arrives over HTTP independent of the socket) a
//     chance to cancel it.
//  2. Backstop: a periodic sweep catches sessions where no fast-path signal
//     ever fired at all (e.g. the browser was killed outright, so neither a
//     clean disconnect nor further audio ever arrives).
import { pool } from '../config/db.js';
import { updateSessionStatus, getSession } from '../db/sessions.queries.js';
import { createLogger } from '../utils/logger.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

const log = createLogger('sessionLifecycle');

// How long to wait after a participant socket disconnects before treating the
// session as abandoned, if nothing else happens in the meantime.
const DISCONNECT_GRACE_MS = 3 * 60 * 1000; // 3 minutes

// Backstop: sessions with no message/audio activity for this long are ended
// even if no disconnect was ever observed for them.
const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Per-session pending abandon-check timers (fast path).
const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();

// Last-known-activity timestamps, updated by audio uploads and session:join.
// Used only to short-circuit an abandon check / the sweep; the source of
// truth for "is this session really dead" is always re-checked against the
// DB (message timestamps) before anything is finalized.
const lastActivity = new Map<string, number>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Record that a session showed a sign of life (audio chunk, socket rejoin). */
export function noteSessionActivity(sessionId: string): void {
  lastActivity.set(sessionId, Date.now());
  // Opportunistic prune: nothing ever deleted entries, so the map grew one
  // entry per session for the life of the process. Entries older than the
  // inactivity timeout belong to dead sessions — every reader only looks at
  // much shorter windows (DISCONNECT_GRACE_MS), so pruning them is invisible.
  if (lastActivity.size > 500) {
    const cutoff = Date.now() - INACTIVITY_TIMEOUT_MS;
    for (const [id, ts] of lastActivity) {
      if (ts < cutoff) lastActivity.delete(id);
    }
  }
  const pending = pendingChecks.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    pendingChecks.delete(sessionId);
  }
}

/** Test hook: current last-activity map size (leak regression guard). */
export function _lastActivitySizeForTests(): number {
  return lastActivity.size;
}

/** Schedule a grace-window abandon check after a participant socket disconnects. */
export function scheduleAbandonCheck(sessionId: string, delayMs = DISCONNECT_GRACE_MS): void {
  if (pendingChecks.has(sessionId)) return; // already scheduled
  const timer = setTimeout(() => {
    pendingChecks.delete(sessionId);
    void checkAndFinalizeIfAbandoned(sessionId).catch(err =>
      log.error({ err }, `abandon check failed for ${sessionId}`)
    );
  }, delayMs);
  pendingChecks.set(sessionId, timer);
}

/** Re-check a single session against the DB and finalize it if truly idle. */
async function checkAndFinalizeIfAbandoned(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return; // already ended, or gone

  const recentlySeen = (lastActivity.get(sessionId) ?? 0) > Date.now() - DISCONNECT_GRACE_MS;
  if (recentlySeen) return; // a rejoin/audio chunk canceled this in the meantime

  const idleForMs = await getIdleDurationMs(sessionId, session.created_at);
  if (idleForMs < DISCONNECT_GRACE_MS) return; // brand-new session, give it time

  log.info(`Finalizing abandoned session ${sessionId.substring(0, 12)}... (disconnect grace window elapsed)`);
  await finalizeAbandonedSession(sessionId);
}

/** How long since this session last showed activity (message or session start). */
async function getIdleDurationMs(sessionId: string, createdAt: Date): Promise<number> {
  const result = await pool.query<{ last_at: Date | null }>(
    `SELECT MAX(created_at) AS last_at FROM messages WHERE session_id = $1`,
    [sessionId]
  );
  const lastMessageAt = result.rows[0]?.last_at;
  const lastKnown = lastMessageAt && lastMessageAt > createdAt ? lastMessageAt : createdAt;
  return Date.now() - new Date(lastKnown).getTime();
}

/**
 * Server-authoritative session end (ai-therapist-112/113): status update,
 * sideband teardown, redaction→naming, recording finalize, insights, evals,
 * and the socket notifications — the same chain the /end route runs. No-ops
 * if the session already ended (client beat us to it). Used by the crisis
 * wind-down backstop and the end_session tool's server-side backstop, so a
 * session can never stay active just because the client's POST /end was lost.
 */
export async function serverEndSession(
  sessionId: string,
  opts: { endedBy: string; reason: string; message?: string },
): Promise<boolean> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return false;

  await updateSessionStatus(sessionId, 'ended', opts.endedBy);

  try {
    const { sidebandManager } = await import('./sidebandManager.service.js');
    await sidebandManager.disconnect(sessionId);
  } catch (err) {
    log.error({ err }, `[serverEnd] sideband cleanup failed for ${sessionId}`);
  }

  import('./sessionRedaction.service.js')
    .then(m => m.redactSession(sessionId))
    .then(() => import('./sessionName.service.js').then(m => m.generateSessionNameAsync(sessionId)))
    .catch(err => log.error({ err }, `[serverEnd] redaction/naming failed for ${sessionId}`));
  import('./recorder.service.js')
    .then(m => m.finalize(sessionId))
    .catch(err => log.error({ err }, `[serverEnd] recorder finalize failed for ${sessionId}`));
  import('./sessionInsights.service.js')
    .then(m => m.generateSessionInsightsAsync(sessionId))
    .catch(err => log.error({ err }, `[serverEnd] insights failed for ${sessionId}`));
  import('./sessionEval.service.js')
    .then(m => m.maybeAutoEvalSession(sessionId))
    .catch(err => log.error({ err }, `[serverEnd] auto-eval failed for ${sessionId}`));

  if (global.io) {
    global.io.to(`session:${sessionId}`).emit('session:status', {
      status: 'ended',
      endedBy: opts.endedBy,
      reason: opts.reason,
      ...(opts.message ? { message: opts.message } : {}),
      remoteTermination: true,
    });
    void broadcastAdminEventForSession(global.io, 'session:ended', {
      sessionId, endedAt: new Date(), endedBy: opts.endedBy, reason: opts.reason,
    }, sessionId, 'summary');
  }
  return true;
}

/** End the session, finalize its recording, and trigger redaction — mirrors the /end route. */
async function finalizeAbandonedSession(sessionId: string): Promise<void> {
  await updateSessionStatus(sessionId, 'ended', 'system');

  try {
    const { sidebandManager } = await import('./sidebandManager.service.js');
    await sidebandManager.disconnect(sessionId);
  } catch (err) {
    log.error({ err }, `[Sideband] cleanup on abandon-finalize failed for ${sessionId}`);
  }

  const { redactSession } = await import('./sessionRedaction.service.js');
  redactSession(sessionId).catch(err => log.error({ err }, `[Redaction] abandon-finalize failed for ${sessionId}`));

  const { finalize } = await import('./recorder.service.js');
  finalize(sessionId).catch(err => log.error({ err }, `[Recorder] abandon-finalize failed for ${sessionId}`));

  if (global.io) {
    void broadcastAdminEventForSession(global.io, 'session:ended', { sessionId, endedAt: new Date(), endedBy: 'system', reason: 'abandoned' }, sessionId, 'summary');
    global.io.to(`session:${sessionId}`).emit('session:status', { status: 'ended', endedBy: 'system', reason: 'abandoned' });
  }
}

/** Backstop sweep: catches abandoned sessions with no fast-path signal at all. */
export async function sweepAbandonedSessions(): Promise<{ finalized: number }> {
  const cutoff = new Date(Date.now() - INACTIVITY_TIMEOUT_MS);
  const result = await pool.query<{ session_id: string }>(
    `SELECT ts.session_id
       FROM therapy_sessions ts
       LEFT JOIN messages m ON m.session_id = ts.session_id
      WHERE ts.status = 'active'
        AND ts.is_demo IS NOT TRUE
      GROUP BY ts.session_id, ts.created_at
     HAVING GREATEST(ts.created_at, COALESCE(MAX(m.created_at), ts.created_at)) < $1`,
    [cutoff]
  );

  for (const row of result.rows) {
    try {
      await finalizeAbandonedSession(row.session_id);
    } catch (err) {
      log.error({ err }, `sweep finalize failed for ${row.session_id}`);
    }
  }

  if (result.rows.length > 0) {
    log.info(`Abandoned-session sweep finalized ${result.rows.length} session(s)`);
  }
  return { finalized: result.rows.length };
}

/** Start the periodic backstop sweep. Safe to call once at server startup. */
export function startAbandonedSessionSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepAbandonedSessions().catch(err => log.error({ err }, 'abandoned-session sweep failed'));
  }, SWEEP_INTERVAL_MS);
  // Node timers otherwise keep the process alive during tests/scripts.
  sweepTimer.unref?.();
}

export function stopAbandonedSessionSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
