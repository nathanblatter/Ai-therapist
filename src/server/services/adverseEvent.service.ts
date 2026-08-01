// Adverse-event draft assembler (ai-therapist-95). Turns a qualifying crisis
// into a self-contained IRB adverse-event draft: it snapshots the timeline
// (crisis events + risk-check ladder bands + intervention actions) and a
// REDACTED transcript excerpt into the row, so later content wipes or session
// deletion never hollow out the filed report. Raw message content NEVER enters
// an AE row — only content_redacted or redactPHIBatch output.
import {
  getLatestCrisisEventId,
  getRiskCheckSteps,
  getSessionInterventionActions,
  getSessionAeSnapshot,
  getRecentSessionMessages,
  insertAdverseEventDraft,
  type AdverseEventTimelineEntry,
  type AdverseEventActionEntry,
} from '../db/index.js';
import { getSessionCrisisEvents } from './crisisDetection.service.js';
import { redactPHIBatch } from './redaction.service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('adverseEvent');

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number') return new Date(v).toISOString();
  return null;
}

/** Build the REDACTED transcript excerpt from the last N messages. Uses
 *  content_redacted when present; redacts the rest via redactPHIBatch. Raw
 *  content is never returned. */
async function buildRedactedExcerpt(sessionId: string): Promise<string | null> {
  const messages = await getRecentSessionMessages(sessionId, 10);
  if (messages.length === 0) return null;

  // Redact any messages that lack a stored redacted form.
  const needRedaction = messages
    .map((m, idx) => ({ idx, content: m.content ?? null, hasRedacted: !!m.content_redacted }))
    .filter(m => !m.hasRedacted && m.content);
  let redactedById = new Map<number, string>();
  if (needRedaction.length > 0) {
    redactedById = await redactPHIBatch(needRedaction.map(m => ({ id: m.idx, content: m.content })));
  }

  const lines = messages.map((m, idx) => {
    const who = m.role === 'user' ? 'Participant' : m.role === 'assistant' ? 'Assistant' : m.role;
    const text = m.content_redacted ?? redactedById.get(idx) ?? '[redacted]';
    return `${who}: ${text}`;
  });
  return lines.join('\n');
}

interface DraftOptions {
  triggerSource?: 'auto_crisis_flag' | 'manual';
  createdBy?: string;
}

/**
 * Auto-draft (or manually draft) an AE report from a session's latest crisis.
 * Idempotent per crisis_event_id (partial unique index + ON CONFLICT DO
 * NOTHING) for the auto path. Manual drafts use crisis_event_id=null so they
 * never collide. Fire-and-forget from the crisis pipeline — MUST NEVER throw.
 * Returns the new report_id, or null (already drafted, no session, or error).
 */
export async function draftAdverseEventFromCrisis(sessionId: string, opts: DraftOptions = {}): Promise<number | null> {
  const triggerSource = opts.triggerSource ?? 'auto_crisis_flag';
  const createdBy = opts.createdBy ?? 'system';
  try {
    const snapshot = await getSessionAeSnapshot(sessionId);
    if (!snapshot) {
      log.warn({ sessionId }, 'AE draft skipped: session not found');
      return null;
    }

    // Manual drafts are not tied to a specific crisis event (avoids colliding
    // with the auto per-event unique index).
    const crisisEventId = triggerSource === 'manual' ? null : await getLatestCrisisEventId(sessionId);

    const [crisisEvents, riskSteps, actions] = await Promise.all([
      getSessionCrisisEvents(sessionId),
      getRiskCheckSteps(sessionId),
      getSessionInterventionActions(sessionId),
    ]);

    // Timeline: crisis events + risk-check ladder bands (NOT raw answers) +
    // intervention actions, sorted chronologically.
    const timeline: AdverseEventTimelineEntry[] = [];
    for (const raw of crisisEvents as Array<Record<string, unknown>>) {
      timeline.push({
        at: toIso(raw.created_at),
        kind: 'crisis_event',
        detail: `${String(raw.event_type ?? 'event')}${raw.severity ? ` (${raw.severity})` : ''}${raw.risk_score != null ? ` — risk ${raw.risk_score}` : ''}`,
      });
    }
    for (const step of riskSteps) {
      timeline.push({
        at: toIso(step.created_at),
        kind: 'risk_check',
        detail: `${step.step}: ${step.risk_band}`,
      });
    }
    for (const a of actions) {
      timeline.push({ at: toIso(a.performed_at), kind: 'intervention', detail: a.action_type });
    }
    timeline.sort((x, y) => (x.at ?? '').localeCompare(y.at ?? ''));

    const actionsTaken: AdverseEventActionEntry[] = actions.map(a => ({
      at: toIso(a.performed_at),
      action: a.action_type,
      by: a.performed_by,
    }));

    const transcriptExcerpt = await buildRedactedExcerpt(sessionId);

    const occurredAt = snapshot.crisis_flagged_at ? new Date(snapshot.crisis_flagged_at) : new Date();
    const dueAt = new Date(occurredAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const severity = (['low', 'medium', 'high'] as const).includes(snapshot.crisis_severity as 'high')
      ? (snapshot.crisis_severity as 'low' | 'medium' | 'high')
      : 'high';
    const participantRef = snapshot.user_id != null ? `user ${snapshot.user_id}` : 'anonymous';
    const summary = triggerSource === 'manual'
      ? `Manually filed adverse-event report at ${new Date().toISOString()}. Review and complete.`
      : `Auto-drafted from high-severity crisis flag at ${occurredAt.toISOString()}, risk score ${snapshot.crisis_risk_score ?? 'n/a'}. Review and complete.`;

    const reportId = await insertAdverseEventDraft({
      sessionId,
      crisisEventId,
      userId: snapshot.user_id,
      sessionRef: sessionId,
      participantRef,
      occurredAt,
      severity,
      triggerSource,
      summary,
      timeline,
      transcriptExcerpt,
      actionsTaken,
      dueAt,
      createdBy,
    });

    if (reportId == null) {
      log.info({ sessionId, crisisEventId }, 'AE draft already exists for this crisis event (idempotent no-op)');
    } else {
      log.info({ sessionId, reportId, triggerSource }, 'AE draft created');
    }
    return reportId;
  } catch (err) {
    // Fire-and-forget contract: swallow so the crisis pipeline is never affected.
    log.error({ err, sessionId }, 'AE draft assembly failed (non-fatal)');
    return null;
  }
}

/**
 * Auto-draft an AE report from a confirmed age-eligibility violation
 * (ai-therapist-106). Same snapshot machinery as the crisis assembler
 * (timeline from intervention actions, redacted excerpt) but categorized as an
 * eligibility_violation with trigger_source='auto_eligibility'. Idempotent per
 * session via the partial unique index (ON CONFLICT DO NOTHING). Fire-and-forget
 * — MUST NEVER throw. Returns the new report_id, or null (already drafted / no
 * session / error).
 */
export async function draftAdverseEventFromEligibility(
  sessionId: string,
  opts: { statedAge: number | null; messageId?: string | number | null } = { statedAge: null },
): Promise<number | null> {
  try {
    const snapshot = await getSessionAeSnapshot(sessionId);
    if (!snapshot) {
      log.warn({ sessionId }, 'Eligibility AE draft skipped: session not found');
      return null;
    }

    const actions = await getSessionInterventionActions(sessionId);

    const timeline: AdverseEventTimelineEntry[] = actions.map(a => ({
      at: toIso(a.performed_at),
      kind: 'intervention',
      detail: a.action_type,
    }));
    timeline.sort((x, y) => (x.at ?? '').localeCompare(y.at ?? ''));

    const actionsTaken: AdverseEventActionEntry[] = actions.map(a => ({
      at: toIso(a.performed_at),
      action: a.action_type,
      by: a.performed_by,
    }));

    const transcriptExcerpt = await buildRedactedExcerpt(sessionId);

    const occurredAt = new Date();
    const dueAt = new Date(occurredAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const participantRef = snapshot.user_id != null ? `user ${snapshot.user_id}` : 'anonymous';
    const summary =
      `Auto-drafted: participant disclosed being a minor (stated age ${opts.statedAge ?? 'unknown'}) ` +
      `at ${occurredAt.toISOString()}. Session ended per protocol. Review and complete.`;

    const reportId = await insertAdverseEventDraft({
      sessionId,
      crisisEventId: null,
      userId: snapshot.user_id,
      sessionRef: sessionId,
      participantRef,
      occurredAt,
      severity: 'medium',
      triggerSource: 'auto_eligibility',
      category: 'eligibility_violation',
      summary,
      timeline,
      transcriptExcerpt,
      actionsTaken,
      dueAt,
      createdBy: 'system',
    });

    if (reportId == null) {
      log.info({ sessionId }, 'Eligibility AE draft already exists for this session (idempotent no-op)');
    } else {
      log.info({ sessionId, reportId }, 'Eligibility AE draft created');
    }
    return reportId;
  } catch (err) {
    log.error({ err, sessionId }, 'Eligibility AE draft assembly failed (non-fatal)');
    return null;
  }
}
