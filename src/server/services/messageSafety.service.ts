// Message-safety scan for async thread messages (caseworker portal,
// docs/caseworker-portal.md sections 3-5). Fire-and-forget: the send route
// inserts the participant message with scan_status='pending' and calls
// scanThreadMessage() without awaiting — a scan failure can never block or
// break message delivery (the message lands as 'scan_failed', not lost).
//
// Pipeline per participant message:
//   sandbox thread        -> scan_status='not_applicable', nothing else
//   stage-1 keyword screen (every message; free)
//   stage-2 LLM on any hit (analyzeStandaloneRisk: no trajectory, no
//                           risk_score_history, no sweep counter)
//   medium/high severity  -> crisis_events row (origin='thread_message',
//                            migration 076) + 'message_crisis' work item +
//                            in-app care-team notifications WITHOUT the
//                            verbatim body + summary-tier admin broadcast;
//                            high additionally pages on-call (sendCrisisAlert,
//                            Nathan decision Q5/2026-08-28)
//
// Message risk lives on thread_messages (risk_score/risk_severity), NOT in
// risk_score_history — that table's trajectory logic is session-local.
import { createLogger } from '../utils/logger.js';
import { analyzeStandaloneRisk } from './crisisDetection.service.js';
import { pageOnCall } from './crisisIntervention.service.js';
import { broadcastAdminEvent } from '../utils/adminBroadcast.js';
import {
  listThreadMessages,
  updateThreadMessageScan,
  claimStaleScanMessages,
  getThreadById,
  recordCrisisEvent,
  type MessageThreadRow,
  type ThreadMessageRow,
} from '../db/index.js';
import { enqueueWorkItem } from './workQueue.service.js';

const log = createLogger('messageSafety');

/** Per-user messaging socket room (joined by every authenticated socket;
 *  used ONLY for messaging events — see docs/caseworker-portal.md C7). */
export function userRoom(userId: number): string {
  return `user:${userId}`;
}

/** Recent thread turns for the LLM's context judgment, oldest first,
 *  excluding the message being scanned. Participant turns map to role
 *  'user'; the clinician's to 'assistant' (the counterpart voice). */
async function threadHistoryLines(
  threadId: number,
  excludeMessageId: number
): Promise<Array<{ role: string; content: string }>> {
  const recent = await listThreadMessages(threadId, { limit: 10 });
  return recent
    .filter((m) => m.message_id !== excludeMessageId)
    .map((m) => ({
      role: m.sender_role === 'participant' ? 'user' : 'assistant',
      content: m.body,
    }));
}

/**
 * Insert the origin='thread_message' crisis event (076 widened crisis_events;
 * session_id stays NULL). trigger_method='auto', triggered_by='system',
 * event_type='flagged' per the migration note. Notes carry score + factor
 * labels only — never the message body.
 */
function insertMessageCrisisEvent(input: {
  messageId: number;
  clientUserId: number;
  severity: 'medium' | 'high';
  riskScore: number;
  factors: string[];
}): Promise<number> {
  return recordCrisisEvent({
    origin: 'thread_message',
    threadMessageId: input.messageId,
    clientUserId: input.clientUserId,
    eventType: 'flagged',
    severity: input.severity,
    riskScore: input.riskScore,
    triggeredBy: 'system',
    triggerMethod: 'auto',
    riskFactors: input.factors,
    notes: `Message risk score: ${input.riskScore} - Factors: ${input.factors.join(', ')}`,
  });
}

function emitScanned(thread: MessageThreadRow, messageId: number, flagged: boolean): void {
  // Participant-facing scan echo: flagged yes/no only — no score/severity
  // leaks to the participant (event catalog, docs/caseworker-portal.md §5).
  if (!global.io) return;
  global.io.to(userRoom(thread.client_id)).emit('messaging:message-scanned', {
    threadId: thread.thread_id,
    messageId,
    flagged,
  });
}

/**
 * Scan one participant thread message. Best-effort and fire-and-forget:
 * never throws (callers `void` it). Clinician messages are never scanned —
 * the send route inserts them as 'not_applicable' and does not call this.
 */
export async function scanThreadMessage(
  message: ThreadMessageRow,
  thread: MessageThreadRow
): Promise<void> {
  try {
    // Sandbox short-circuit (docs/caseworker-portal.md §7 exclusion point 8):
    // demo caseloads exercise the messaging UI without waking the LLM, the
    // crisis audit trail, the work queue, or the on-call pager.
    if (thread.is_sandbox) {
      await updateThreadMessageScan(message.message_id, { scanStatus: 'not_applicable' });
      emitScanned(thread, message.message_id, false);
      return;
    }

    const history = await threadHistoryLines(thread.thread_id, message.message_id).catch((err) => {
      // History is context sugar for the LLM; scan the message alone on failure.
      log.error({ err }, '[scan] thread history lookup failed; scanning without context');
      return [] as Array<{ role: string; content: string }>;
    });

    const risk = await analyzeStandaloneRisk(message.body, history);

    // Indeterminate verdict (LLM down, no keyword floor): do NOT record this as
    // clear — leave it scan_failed so the sweeper retries once the LLM recovers
    // (ai-therapist-142). Throw into the catch, which marks scan_failed.
    if (risk.indeterminate) {
      throw new Error('standalone risk verdict indeterminate (LLM unavailable, no keyword floor)');
    }

    const flagged = risk.severity === 'medium' || risk.severity === 'high';

    if (!flagged) {
      await updateThreadMessageScan(message.message_id, {
        scanStatus: 'clear',
        riskScore: risk.riskScore,
        riskSeverity: risk.severity === 'low' ? 'low' : null,
      });
      emitScanned(thread, message.message_id, false);
      return;
    }

    const severity = risk.severity as 'medium' | 'high';

    // LIFE-SAFETY FIRST (ai-therapist-141 #1): page the on-call BEFORE any DB
    // write, so a transient failure persisting the crisis event / work item can
    // never suppress the alert. On a re-scan of a message that was already
    // recorded (crisis_event_id set), the original page already fired (paging
    // precedes persistence), so skip re-paging to avoid duplicate alerts.
    const alreadyRecorded = message.crisis_event_id != null;
    if (severity === 'high' && !alreadyRecorded) {
      await pageOnCall(
        `CRISIS MESSAGE ALERT: high-severity risk flagged in a client message ` +
          `(score ${risk.riskScore}/100). Review the crisis dashboard.`
      ).catch((err) => log.error({ err }, '[scan] on-call page failed for high-severity message'));
    }

    // Record-keeping. If any of this throws, the catch marks scan_failed and the
    // sweeper retries — but the page above has already gone out. Reuse an
    // existing crisis_event_id on re-scan so retries don't duplicate the event.
    const crisisEventId = alreadyRecorded
      ? message.crisis_event_id!
      : await insertMessageCrisisEvent({
          messageId: message.message_id,
          clientUserId: thread.client_id,
          severity,
          riskScore: risk.riskScore,
          factors: risk.factors,
        });

    await updateThreadMessageScan(message.message_id, {
      scanStatus: 'flagged',
      riskScore: risk.riskScore,
      riskSeverity: severity,
      crisisEventId,
    });

    // Pool work item for the client's care team (idempotent per message)
    // via the single choke point: enqueueWorkItem inserts the item, fans out
    // work_item:new sockets, and drives the care-team in-app notifications +
    // email policy (spec section 5: high -> urgent immediate). The payload
    // carries severity + factor labels, never the message body (Nathan
    // decision 5, 2026-08-28). Never throws.
    await enqueueWorkItem({
      orgId: thread.org_id,
      clientId: thread.client_id,
      itemType: 'message_crisis',
      severity: severity === 'high' ? 'urgent' : 'warning',
      title: `Client message flagged (${severity} risk)`,
      detail: {
        thread_id: thread.thread_id,
        message_id: message.message_id,
        crisis_event_id: crisisEventId,
        risk_score: risk.riskScore,
        severity,
        factors: risk.factors, // short labels, never message text
      },
      sourceTable: 'thread_messages',
      sourceId: String(message.message_id),
      isSandbox: thread.is_sandbox,
    });

    // Summary-tier admin broadcast: severity/factors/refs — never the body.
    if (global.io) {
      void broadcastAdminEvent(
        global.io,
        'message:crisis-detected',
        {
          clientId: thread.client_id,
          threadId: thread.thread_id,
          messageId: message.message_id,
          crisisEventId,
          severity,
          riskScore: risk.riskScore,
          factors: risk.factors,
          detectedAt: new Date(),
        },
        thread.client_id,
        'summary'
      );
    }

    emitScanned(thread, message.message_id, true);
    log.info(
      `[scan] message ${message.message_id} (thread ${thread.thread_id}) flagged ${severity} ` +
        `(score ${risk.riskScore}, event ${crisisEventId})`
    );
  } catch (err) {
    log.error({ err }, `[scan] scan failed for message ${message.message_id}; marking scan_failed`);
    try {
      // Never downgrade a row that already reached 'flagged' (ai-therapist-141
      // #5): a late error must not erase a good crisis flag or null its score.
      await updateThreadMessageScan(message.message_id, {
        scanStatus: 'scan_failed',
        onlyIfNotFlagged: true,
      });
    } catch (updateErr) {
      log.error({ err: updateErr }, '[scan] failed to record scan_failed status');
    }
  }
}

// ============================================
// STALE-SCAN SWEEPER (ai-therapist-141 #2)
// ============================================
// The scan is fire-and-forget in memory, so a deploy/crash/error between
// message insert and terminal scan status strands the row ('pending' forever)
// or leaves it 'scan_failed' with no retry. This backstop re-scans both so no
// participant message goes permanently unscreened. Idempotent: scanThreadMessage
// reuses an existing crisis_event_id and skips re-paging already-recorded rows.

const SWEEP_INTERVAL_MS = 3 * 60 * 1000;
const SWEEP_BATCH = 50;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Re-scan one batch of stranded participant messages. Never throws. */
export async function sweepStaleScans(): Promise<number> {
  try {
    const stale = await claimStaleScanMessages(SWEEP_BATCH);
    if (stale.length === 0) return 0;
    log.warn(`[scan-sweep] re-scanning ${stale.length} stranded message(s)`);
    for (const message of stale) {
      const thread = await getThreadById(message.thread_id);
      if (!thread) {
        // Thread gone (retention wipe): mark terminal so it stops being swept.
        await updateThreadMessageScan(message.message_id, { scanStatus: 'not_applicable' }).catch(() => {});
        continue;
      }
      await scanThreadMessage(message, thread);
    }
    return stale.length;
  } catch (err) {
    log.error({ err }, '[scan-sweep] sweep pass failed');
    return 0;
  }
}

/** Start the periodic stale-scan sweeper (boot pass after a short delay, then
 *  every few minutes). Idempotent; safe to call once at startup. */
export function startMessageScanSweeper(): void {
  if (sweepTimer) return;
  // Boot pass, slightly delayed so migrations/warmup settle.
  setTimeout(() => { void sweepStaleScans(); }, 15_000);
  sweepTimer = setInterval(() => { void sweepStaleScans(); }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}
