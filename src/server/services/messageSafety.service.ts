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
    const crisisEventId = await insertMessageCrisisEvent({
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

    // High severity pages the on-call (approved Q5). PHI-free by design.
    // No session link: thread messages have no therapy session, and the
    // sandbox short-circuit above already covers suppression for this path.
    if (severity === 'high') {
      await pageOnCall(
        `CRISIS MESSAGE ALERT: high-severity risk flagged in a client message ` +
          `(score ${risk.riskScore}/100). Review the crisis dashboard.`
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
      await updateThreadMessageScan(message.message_id, { scanStatus: 'scan_failed' });
    } catch (updateErr) {
      log.error({ err: updateErr }, '[scan] failed to record scan_failed status');
    }
  }
}
