// Work-queue producer service (caseworker portal, spec sections 3 and 5).
// enqueueWorkItem is the SINGLE ENTRY POINT for creating work items: it
// resolves client -> org/sandbox, inserts idempotently, fans out socket
// events, and calls notification.service (the only caller of that service).
// Best-effort by design: it NEVER throws into producers — a queue failure
// must not break the crisis pipeline, escalation flow, or messaging path
// that called it.
//
// Also owns the sweeps (spec section 5 producers with no source row):
//   - daily work-item sweep: inactivity / screener_worsening /
//     message_unread_stale items + expiry reconciliation,
//   - hourly digest sweep (delegates to notification.service).
// Sweep SQL lives here with direct pool access, matching the
// dataRetention/contentWipe sweep-service pattern.
import { pool } from '../config/db.js';
import {
  insertWorkItem,
  getSessionAccessInfo,
  getUserById,
  getCareTeam,
  getIrbStudyOrgId,
  getOrgTherapistIds,
  type WorkItemRow,
  type WorkItemType,
  type WorkItemSeverity,
} from '../db/index.js';
import type { CareTeamRole } from '../../shared/roles.js';
import { therapistRoom, caseworkerRoom } from '../utils/adminBroadcast.js';
import {
  notifyWorkItem,
  runDigestSweep,
  type NotificationRecipient,
} from './notification.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('workQueue');

export interface EnqueueWorkItemOptions {
  itemType: WorkItemType;
  severity?: WorkItemSeverity;
  /** In-app title. May reference the client; NEVER copied into email. */
  title: string;
  /** Reason payload; NEVER transcript/message text. */
  detail?: unknown;
  sourceTable: string;
  sourceId: string;
  clientId?: number | null;
  /** Fallback client resolution when the producer only has a session id. */
  sessionId?: string | null;
  /** Resolved from the client's row when absent. */
  orgId?: number | null;
  /** NULL assignee = pool item for the client's care team. */
  assigneeId?: number | null;
  assigneeRole?: CareTeamRole | null;
  /** Resolved from users.is_sandbox when absent. */
  isSandbox?: boolean;
  /** Fan the socket/notification recipients out to EVERY therapist in the
   *  item's org (spec 072: emergency escalation with no assignee — a
   *  caseworker-only care team must still reach someone who can act). */
  notifyOrgTherapists?: boolean;
  /** Reactivate a resolved/expired item with the same source key instead of
   *  no-opping (crisis re-flag, escalation reopen, renewed inactivity). The
   *  reactivated item re-notifies; open/acked duplicates stay silent. */
  reopen?: boolean;
}

async function resolveRecipients(
  item: WorkItemRow,
  assigneeRole: CareTeamRole | null | undefined
): Promise<NotificationRecipient[]> {
  if (item.assignee_id !== null) {
    return [{ userId: item.assignee_id, role: assigneeRole ?? item.assignee_role ?? null }];
  }
  if (item.client_id === null) return [];
  const team = await getCareTeam(item.client_id);
  return team.map((member) => ({ userId: member.member_id, role: member.member_role }));
}

function emitToRecipients(event: string, item: WorkItemRow, recipients: NotificationRecipient[]): void {
  const io = global.io;
  if (!io) return;
  // Payload is the work_items row: transcript-free by construction (spec s5).
  for (const recipient of recipients) {
    const room =
      recipient.role === 'caseworker'
        ? caseworkerRoom(recipient.userId)
        : recipient.role === 'therapist'
          ? therapistRoom(recipient.userId)
          : null;
    if (room) io.to(room).emit(event, item);
  }
}

/**
 * Create a work item (idempotent on item_type+source_table+source_id) and
 * fan out sockets + notifications to the assignee or the client's care team.
 * Returns the created row, or null when the item already existed or anything
 * failed (logged). NEVER throws.
 */
export async function enqueueWorkItem(opts: EnqueueWorkItemOptions): Promise<WorkItemRow | null> {
  try {
    let clientId = opts.clientId ?? null;
    if (clientId === null && opts.sessionId) {
      const session = await getSessionAccessInfo(opts.sessionId);
      const raw = session?.user_id;
      clientId = raw === null || raw === undefined ? null : Number(raw);
      if (clientId !== null && !Number.isInteger(clientId)) clientId = null;
    }

    const client = clientId !== null ? await getUserById(clientId) : null;
    const orgId = opts.orgId ?? client?.organization_id ?? (await getIrbStudyOrgId());
    if (typeof orgId !== 'number') {
      log.error({ itemType: opts.itemType, sourceId: opts.sourceId },
        '[queue] could not resolve org for work item; dropping');
      return null;
    }
    const isSandbox = opts.isSandbox ?? client?.is_sandbox ?? false;

    const item = await insertWorkItem({
      orgId,
      clientId,
      assigneeId: opts.assigneeId ?? null,
      assigneeRole: opts.assigneeRole ?? null,
      itemType: opts.itemType,
      severity: opts.severity ?? 'info',
      title: opts.title,
      detail: opts.detail,
      sourceTable: opts.sourceTable,
      sourceId: opts.sourceId,
      isSandbox,
      reopen: opts.reopen,
    });
    if (!item) return null; // idempotent duplicate (still open/acked): no re-notify

    const recipients = await resolveRecipients(item, opts.assigneeRole);
    if (opts.notifyOrgTherapists) {
      // Emergency org fan-out (spec 072): every org therapist gets the work
      // item's socket event + notification, not just the care team.
      const seen = new Set(recipients.map((r) => r.userId));
      for (const therapistId of await getOrgTherapistIds(orgId)) {
        if (!seen.has(therapistId)) {
          recipients.push({ userId: therapistId, role: 'therapist' });
        }
      }
    }
    emitToRecipients('work_item:new', item, recipients);
    await notifyWorkItem(item, recipients);
    return item;
  } catch (err) {
    log.error({ err, itemType: opts.itemType, sourceId: opts.sourceId },
      '[queue] enqueueWorkItem failed');
    return null;
  }
}

/**
 * Fan out a work_item:updated socket event after an ack/resolve (called by
 * workQueue.routes). Best-effort; never throws.
 */
export async function emitWorkItemUpdated(item: WorkItemRow): Promise<void> {
  try {
    const recipients = await resolveRecipients(item, item.assignee_role);
    emitToRecipients('work_item:updated', item, recipients);
  } catch (err) {
    log.error({ err, itemId: item.item_id }, '[queue] emitWorkItemUpdated failed');
  }
}

// ---------------------------------------------------------------------------
// Daily work-item sweep
// ---------------------------------------------------------------------------

export interface SweepThresholds {
  inactivity_days: number;
  screener_worsen_delta: number;
  stale_unread_days: number;
}

export const DEFAULT_SWEEP_THRESHOLDS: SweepThresholds = {
  inactivity_days: 14,
  screener_worsen_delta: 5,
  stale_unread_days: 3,
};

function denverDateStamp(now: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now);
}

/**
 * Daily producer + reconciliation sweep (spec section 5):
 *   inactivity          ONE pool item per client with a care team and no
 *                       session in `inactivity_days` (synthetic per-client
 *                       source id; an already-open item is refreshed as a
 *                       no-op, never duplicated; open items auto-expire on
 *                       re-engagement and reactivate if inactivity recurs)
 *   screener_worsening  pool item when a client's latest screener score rose
 *                       by >= delta vs the previous response (last 30 days)
 *   message_unread_stale item for the thread clinician when a participant
 *                       message has sat unread for `stale_unread_days`
 * All inserts go through enqueueWorkItem (idempotent + notification choke
 * point). Never throws.
 */
export async function runWorkItemSweep(
  thresholds: SweepThresholds = DEFAULT_SWEEP_THRESHOLDS,
  _now: Date = new Date() // kept for signature stability (scheduler passes it)
): Promise<void> {
  // --- inactivity: expire stale items for re-engaged clients first ---------
  try {
    await pool.query(
      `UPDATE work_items wi SET status = 'expired'
       WHERE wi.item_type = 'inactivity' AND wi.status IN ('open', 'acked')
         AND EXISTS (
           SELECT 1 FROM therapy_sessions ts
           WHERE ts.user_id = wi.client_id
             AND ts.created_at > now() - ($1 || ' days')::interval
         )`,
      [thresholds.inactivity_days]
    );
  } catch (err) {
    log.error({ err }, '[sweep] inactivity expiry failed');
  }

  try {
    const inactive = await pool.query<{ client_id: number }>(
      `SELECT DISTINCT tc.client_id
       FROM therapist_clients tc
       JOIN users u ON u.userid = tc.client_id
       WHERE EXISTS (SELECT 1 FROM therapy_sessions ts WHERE ts.user_id = tc.client_id)
         AND NOT EXISTS (
           SELECT 1 FROM therapy_sessions ts
           WHERE ts.user_id = tc.client_id
             AND ts.created_at > now() - ($1 || ' days')::interval
         )`,
      [thresholds.inactivity_days]
    );
    for (const row of inactive.rows) {
      // Per-CLIENT source id (no date): one open inactivity item per client.
      // While it stays open the daily re-detection is an idempotent no-op;
      // after it expires on re-engagement (or is resolved), a recurrence
      // reactivates the same row and notifies again (reopen).
      await enqueueWorkItem({
        itemType: 'inactivity',
        severity: 'info',
        title: `No sessions in ${thresholds.inactivity_days}+ days`,
        detail: { days_threshold: thresholds.inactivity_days },
        sourceTable: 'therapy_sessions',
        sourceId: `inactivity:${row.client_id}`,
        clientId: row.client_id,
        reopen: true,
      });
    }
  } catch (err) {
    log.error({ err }, '[sweep] inactivity producer failed');
  }

  // --- screener_worsening --------------------------------------------------
  try {
    const worsening = await pool.query<{
      client_id: number;
      scale: string;
      latest_score: number;
      previous_score: number;
      latest_at: string;
    }>(
      `WITH ranked AS (
         SELECT ts.user_id AS client_id, sr.scale, sr.score, sr.created_at,
                ROW_NUMBER() OVER (PARTITION BY ts.user_id, sr.scale
                                   ORDER BY sr.created_at DESC) AS rn
         FROM scale_responses sr
         JOIN therapy_sessions ts ON ts.session_id = sr.session_id
         WHERE ts.user_id IS NOT NULL
       )
       SELECT cur.client_id, cur.scale,
              cur.score AS latest_score, prev.score AS previous_score,
              cur.created_at::date::text AS latest_at
       FROM ranked cur
       JOIN ranked prev ON prev.client_id = cur.client_id
                        AND prev.scale = cur.scale AND prev.rn = 2
       WHERE cur.rn = 1
         AND cur.score - prev.score >= $1
         AND cur.created_at > now() - INTERVAL '30 days'
         AND EXISTS (SELECT 1 FROM therapist_clients tc WHERE tc.client_id = cur.client_id)`,
      [thresholds.screener_worsen_delta]
    );
    for (const row of worsening.rows) {
      await enqueueWorkItem({
        itemType: 'screener_worsening',
        severity: 'warning',
        title: `${row.scale} score worsening (+${row.latest_score - row.previous_score})`,
        detail: {
          scale: row.scale,
          latest_score: row.latest_score,
          previous_score: row.previous_score,
        },
        sourceTable: 'scale_responses',
        sourceId: `screener:${row.client_id}:${row.scale}:${row.latest_at}`,
        clientId: row.client_id,
      });
    }
  } catch (err) {
    log.error({ err }, '[sweep] screener_worsening producer failed');
  }

  // --- message_unread_stale ------------------------------------------------
  try {
    const stale = await pool.query<{
      thread_id: number;
      client_id: number;
      clinician_id: number;
      clinician_role: CareTeamRole;
      last_message_id: number;
      unread_count: number;
    }>(
      `SELECT t.thread_id, t.client_id, t.clinician_id, t.clinician_role,
              MAX(tm.message_id) AS last_message_id, COUNT(*)::int AS unread_count
       FROM message_threads t
       JOIN thread_messages tm ON tm.thread_id = t.thread_id
                               AND tm.sender_id = t.client_id
       WHERE tm.created_at < now() - ($1 || ' days')::interval
         AND tm.message_id > COALESCE(
           (SELECT trs.last_read_message_id FROM thread_read_state trs
            WHERE trs.thread_id = t.thread_id AND trs.user_id = t.clinician_id), 0)
       GROUP BY t.thread_id, t.client_id, t.clinician_id, t.clinician_role`,
      [thresholds.stale_unread_days]
    );
    for (const row of stale.rows) {
      await enqueueWorkItem({
        itemType: 'message_unread_stale',
        severity: 'info',
        title: `Unread client messages for ${thresholds.stale_unread_days}+ days`,
        detail: { thread_id: row.thread_id, unread_count: row.unread_count },
        sourceTable: 'message_threads',
        sourceId: `thread:${row.thread_id}:${row.last_message_id}`,
        clientId: row.client_id,
        assigneeId: row.clinician_id,
        assigneeRole: row.clinician_role,
      });
    }
  } catch (err) {
    log.error({ err }, '[sweep] message_unread_stale producer failed');
  }
}

// ---------------------------------------------------------------------------
// Scheduler (registered from src/server/index.ts by the integration slice)
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const WORK_ITEM_SWEEP_HOUR = 6; // America/Denver, matching digest defaults
// First tick fires shortly after boot (jittered) so sub-hour restarts cannot
// starve the digest sweep or skip the daily sweep for a whole day.
const INITIAL_TICK_MAX_JITTER_MS = 2 * 60 * 1000;
const SWEEP_STATE_KEY = 'work_queue.last_sweep_date';
let schedulerTimer: NodeJS.Timeout | null = null;
let initialTickTimer: NodeJS.Timeout | null = null;
let lastWorkItemSweepDate: string | null = null;

/**
 * Atomically claim today's daily sweep in system_config. Returns true when
 * this process won the claim (no sweep recorded for `today` yet); false when
 * another instance — or a previous boot of this one — already swept today.
 * The DB claim is what makes restarts and blue-green pairs safe: the
 * in-memory date alone dies with the process.
 */
async function claimWorkItemSweepDate(today: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO system_config (config_key, config_value, description, updated_by)
     VALUES ($1, to_jsonb($2::text), 'Internal: last completed daily work-item sweep date (America/Denver)', 'work-queue-scheduler')
     ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = 'work-queue-scheduler'
       WHERE system_config.config_value <> EXCLUDED.config_value
     RETURNING config_key`,
    [SWEEP_STATE_KEY, today]
  );
  return (result.rowCount ?? 0) > 0;
}

async function schedulerTick(): Promise<void> {
  const now = new Date();
  await runDigestSweep(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      hour12: false,
    }).format(now)
  ) % 24;
  const today = denverDateStamp(now);
  if (hour < WORK_ITEM_SWEEP_HOUR || lastWorkItemSweepDate === today) return;

  try {
    if (!(await claimWorkItemSweepDate(today))) {
      // A previous boot / the paired instance already swept today.
      lastWorkItemSweepDate = today;
      return;
    }
  } catch (err) {
    // Fail toward sweeping: a config-table hiccup must not silently kill the
    // daily sweep (producers are idempotent, so a rare double run is safe).
    log.error({ err }, '[sweep] daily-sweep claim failed; running anyway');
  }
  lastWorkItemSweepDate = today;
  await runWorkItemSweep(DEFAULT_SWEEP_THRESHOLDS, now);
}

/**
 * Start the scheduler: an immediate (jittered 0-2 min, so blue-green pairs
 * don't tick in lockstep) first run, then an hourly tick. Every tick runs the
 * digest sweep; the daily work-item sweep runs on the first tick at/after
 * 06:00 America/Denver, guarded by a persisted per-day claim in
 * system_config so restarts neither skip nor repeat it. Idempotent.
 */
export function startWorkQueueScheduler(): void {
  if (schedulerTimer || initialTickTimer) return;
  const jitterMs = Math.floor(Math.random() * INITIAL_TICK_MAX_JITTER_MS);
  initialTickTimer = setTimeout(() => {
    initialTickTimer = null;
    schedulerTick().catch((err) => log.error({ err }, '[sweep] initial scheduler tick failed'));
  }, jitterMs);
  initialTickTimer.unref?.();
  schedulerTimer = setInterval(() => {
    schedulerTick().catch((err) => log.error({ err }, '[sweep] scheduler tick failed'));
  }, HOUR_MS);
  schedulerTimer.unref?.();
  log.info({ initialTickInMs: jitterMs }, '[sweep] work-queue scheduler started (immediate tick + hourly)');
}

/** Stop the scheduler (tests / shutdown). */
export function stopWorkQueueScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (initialTickTimer) clearTimeout(initialTickTimer);
  schedulerTimer = null;
  initialTickTimer = null;
  lastWorkItemSweepDate = null;
}
