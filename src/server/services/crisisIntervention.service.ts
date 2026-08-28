import { pool } from '../config/db.js';
import { logInterventionAction } from './crisisDetection.service.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

// ============================================
// RISK-ADAPTIVE LIVE STEERING (ai-therapist-42)
// ============================================
// When a message's risk score is elevated (but possibly below the crisis-flag
// threshold), inject de-escalation guidance to the MODEL over the sideband as
// an invisible system message — the participant never sees it, but the
// assistant shifts to validation/safety-assessment before a human steps in.

const STEER_MIN_SCORE = 25;
const STEER_COOLDOWN_MS = 3 * 60 * 1000;
// One shared cooldown map across BOTH pipelines (realtime + chat): a session
// gets one steering per 3 minutes regardless of channel (ai-therapist-105).
const steeringLastSent = new Map<string, number>();

function steeringGuidance(riskScore: number, severity: string): string {
  const base =
    `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
    `Risk signals in this conversation are elevated (score ${riskScore}/100). ` +
    `Slow your pace and keep responses short, warm, and grounded. Prioritize validation and reflective listening over problem-solving. ` +
    `Gently check how the participant is feeling right now.`;
  if (severity === 'high') {
    return base +
      ` Calmly assess their immediate safety, and naturally work the crisis resources from your instructions into the conversation. ` +
      `Stay with them — a human monitor has been alerted.`;
  }
  return base + ` If anything suggests thoughts of self-harm, follow your crisis protocol.`;
}

/**
 * Check-and-consume the steering gate for a session: true means steering should
 * fire now (score at/above threshold AND cooldown elapsed), and the cooldown is
 * marked consumed. Shared by the realtime sideband path and the chat pipeline
 * so a session steers at most once per cooldown window across channels.
 */
export function shouldSteer(sessionId: string, riskScore: number): boolean {
  if (riskScore < STEER_MIN_SCORE) return false;

  const last = steeringLastSent.get(sessionId) ?? 0;
  if (Date.now() - last < STEER_COOLDOWN_MS) return false;

  steeringLastSent.set(sessionId, Date.now());

  // Opportunistic cleanup so ended sessions don't accumulate.
  if (steeringLastSent.size > 500) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, ts] of steeringLastSent) {
      if (ts < cutoff) steeringLastSent.delete(id);
    }
  }
  return true;
}

/** Clear a session's steering cooldown entry (chat end / cleanup). */
export function clearSteeringState(sessionId: string): void {
  steeringLastSent.delete(sessionId);
}

// ============================================
// CHAT-PIPELINE STEERING COPY (ai-therapist-105)
// ============================================
// The realtime steering texts reference sideband injection and client tools
// (show_resource_card, create_safety_plan) that don't exist in the chat
// pipeline; these chat variants replace tool calls with in-reply resources.

/** Chat-channel steering guidance (severity low/medium). */
export function buildChatSteeringGuidance(riskScore: number, severity: string): string {
  void severity; // reserved for future severity-specific tuning; base copy is shared.
  return (
    `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
    `Risk signals in this conversation are elevated (score ${riskScore}/100). ` +
    `Slow your pace and keep responses short, warm, and grounded. Prioritize validation and reflective listening over problem-solving. ` +
    `Gently check how the participant is feeling right now. ` +
    `If anything suggests thoughts of self-harm, follow your crisis protocol and include the crisis resources from your instructions in your reply.`
  );
}

/** Chat-channel high-severity safety-protocol guidance (mirrors the realtime
 *  SAFETY_PROTOCOL_GUIDANCE, but delivers resources in-reply rather than via
 *  client tools). */
export const CHAT_SAFETY_PROTOCOL_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `A high-severity safety concern has been detected and a human monitor has been paged. ` +
  `Shift fully into safety assessment, gently and without alarm. One question at a time, in this order, adapting to their answers: ` +
  `(1) ask directly whether they are having thoughts of ending their life right now; ` +
  `(2) if yes, ask whether they have thought about how; ` +
  `(3) whether they have access to that method; ` +
  `(4) whether they have a timeframe in mind. ` +
  `Between questions, validate and stay warm — do not interrogate. ` +
  `Include the crisis resources from your instructions directly in your reply — the 988 Suicide & Crisis Lifeline (call or text 988) and the Crisis Text Line (text HOME to 741741) — ` +
  `and, if they engage, offer to write out a simple safety plan together in the chat. ` +
  `Do not end the session yourself. Stay with them.`;

/**
 * Inject de-escalation guidance when risk is elevated. Per-session cooldown so
 * a rough patch doesn't flood the model with repeated guidance. No-op when the
 * session has no live sideband connection.
 */
export async function maybeSteerSession(sessionId: string, riskScore: number, severity: string): Promise<void> {
  try {
    if (riskScore < STEER_MIN_SCORE) return;

    // Sideband gate FIRST so the shared cooldown is only consumed when there is
    // actually a live connection to inject into (preserves realtime behavior).
    const { sidebandManager } = await import('./sidebandManager.service.js');
    if (!sidebandManager.getActiveConnections().includes(sessionId)) return;

    if (!shouldSteer(sessionId, riskScore)) return;

    await sidebandManager.injectMessage(sessionId, 'system', steeringGuidance(riskScore, severity), false);
    await logInterventionAction(sessionId, 'risk_steering', { riskScore, severity });

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'session:risk-steering', {
        sessionId,
        riskScore,
        severity,
        steeredAt: new Date(),
      }, sessionId);
    }
    console.log(`Risk steering injected for session ${sessionId} (score ${riskScore}, ${severity})`);
  } catch (error) {
    console.error('Error steering session:', error);
  }
}

// ============================================
// MANUAL-FLAG STEERING (ai-therapist-112)
// ============================================
// A manual admin flag is the most informed risk signal in the system, but it
// used to only record/alert — the live model was never told. Mirror the auto
// pipeline: high gets the structured safety protocol, low/medium gets the
// de-escalation steer. Bypasses the shouldSteer cooldown on purpose — a human
// clicking "flag" always wins over rate limiting.
export async function injectManualFlagGuidance(
  sessionId: string,
  severity: string,
  riskScore: number,
  flaggedBy: string,
): Promise<boolean> {
  try {
    const { sidebandManager } = await import('./sidebandManager.service.js');
    const guidance = severity === 'high'
      ? SAFETY_PROTOCOL_GUIDANCE
      : steeringGuidance(riskScore, severity);
    const injected = await sidebandManager.tryInject(sessionId, 'system', guidance, false);
    if (injected) {
      await logInterventionAction(sessionId, severity === 'high' ? 'safety_protocol' : 'risk_steering', {
        riskScore, severity, trigger: 'manual_flag', flaggedBy,
      });
      console.log(`Manual-flag guidance injected for session ${sessionId} (${severity}, by ${flaggedBy})`);
    }
    return injected;
  } catch (error) {
    console.error('Error injecting manual-flag guidance:', error);
    return false;
  }
}

// ============================================
// CRISIS WIND-DOWN (ai-therapist-112)
// ============================================
// Admin-triggered graceful end for a crisis session: instead of yanking the
// connection (the only previous option), ask the live model to surface crisis
// resources, close warmly, and end the session itself — same two-phase shape
// as the duration-limit path in token.routes.ts, with a hard server-side end
// as the backstop if the model/client doesn't finish within the grace window.

const CRISIS_WIND_DOWN_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `A human monitor has decided this session should come to a close now. In your next reply: ` +
  `calmly and warmly let the participant know the session is wrapping up (do not say why or mention any monitor); ` +
  `call the show_resource_card tool so crisis lines are on their screen; ` +
  `remind them they can call or text 988 any time, day or night; ` +
  `give a brief, caring goodbye (2-3 sentences, no new topics); then immediately call the end_session tool.`;

const WIND_DOWN_GRACE_MS = 75 * 1000;

export async function initiateCrisisWindDown(
  sessionId: string,
  initiatedBy: string,
): Promise<{ injected: boolean }> {
  const { sidebandManager } = await import('./sidebandManager.service.js');
  const injected = await sidebandManager.tryInject(sessionId, 'system', CRISIS_WIND_DOWN_GUIDANCE, true);

  await logInterventionAction(sessionId, 'handoff_initiated', {
    action: 'crisis_wind_down',
    initiatedBy,
    injected,
    graceMs: WIND_DOWN_GRACE_MS,
  });

  // Backstop: if the model/client didn't end the session within the grace
  // window (or there was no sideband to ask), hard-end it server-side. When
  // nothing could be injected, skip the wait — end now.
  const graceMs = injected ? WIND_DOWN_GRACE_MS : 0;
  setTimeout(() => {
    void hardEndCrisisSession(sessionId, initiatedBy).catch(err =>
      console.error(`[CrisisWindDown] hard-end failed for ${sessionId}:`, err));
  }, graceMs);

  return { injected };
}

/** Server-forced crisis end via the shared finalize chain (no-op if already ended). */
async function hardEndCrisisSession(sessionId: string, endedBy: string): Promise<void> {
  const { serverEndSession } = await import('./sessionLifecycle.service.js');
  const ended = await serverEndSession(sessionId, {
    endedBy,
    reason: 'crisis_wind_down',
    message: 'Your session has ended. Please reach out to the resources shared with you any time.',
  });
  if (ended) console.log(`[CrisisWindDown] Grace elapsed — hard-ended session ${sessionId}`);
}

// ============================================
// GRADUATED RESPONSE SYSTEM
// ============================================

/**
 * Execute graduated response based on risk severity.
 * Only 'high' severity triggers a response (admin alert only).
 * @param {string} sessionId - Session ID
 * @param {string} severity - Risk severity ('high' or 'none')
 * @param {number} riskScore - Risk score (0-100)
 */
export async function executeGraduatedResponse(sessionId: string, severity: string, riskScore: number): Promise<void> {
  try {
    if (severity === 'high') {
      await executeHighRiskResponse(sessionId, riskScore);
    }
  } catch (error) {
    console.error('Error executing graduated response:', error);
  }
}

// ============================================
// HIGH RISK RESPONSE
// ============================================

// Structured, laddered safety-assessment guidance injected to the model on a
// high flag. One gentle question at a time (C-SSRS-shaped: ideation → plan →
// means → timeframe), leaning on the client-side tools that already exist.
const SAFETY_PROTOCOL_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `A high-severity safety concern has been detected and a human monitor has been paged. ` +
  `Shift fully into safety assessment, gently and without alarm. One question at a time, in this order, adapting to their answers: ` +
  `(1) ask directly whether they are having thoughts of ending their life right now; ` +
  `(2) if yes, ask whether they have thought about how; ` +
  `(3) whether they have access to that method; ` +
  `(4) whether they have a timeframe in mind. ` +
  `Between questions, validate and stay warm — do not interrogate. ` +
  `Call the show_resource_card tool so crisis lines are on their screen, and if they engage, offer to build a safety plan together using the create_safety_plan tool. ` +
  `Do not end the session yourself. Stay with them.`;

/**
 * Execute high risk intervention: page the on-call phone, alert admin
 * dashboards, and inject the structured safety-assessment protocol into the
 * live model over the sideband.
 */
async function executeHighRiskResponse(sessionId: string, riskScore: number): Promise<void> {
  try {
    await logInterventionAction(sessionId, 'high_risk_emergency', {
      riskScore,
      emergencyProtocol: 'activated'
    });

    // Page a human — the dashboard socket alert only works if someone is
    // looking at the dashboard. Sandbox sessions (synthetic demo caseloads,
    // spec s7 #3) NEVER page the on-call: the suppression is logged, but the
    // dashboard emits + sideband safety protocol below stay ON — that is the
    // product being demoed. ('crisis_sms_suppressed_sandbox' is not in the
    // intervention_actions CHECK (054), so the suppression rides
    // 'external_api_called' with a detail payload.)
    //
    // FAIL TOWARD PAGING: the page is only suppressed on an affirmative
    // sandbox=true. A transient throw from the sandbox lookup (or from any
    // suppression logging) must never swallow a REAL page, so the check is
    // isolated in its own try/catch and the suppression log is kept out of
    // the paging critical path entirely (fire-and-forget).
    import('./crisisAlert.service.js')
      .then(async m => {
        let isSandbox = false;
        try {
          const { isSandboxAccountSession } = await import('../db/index.js');
          isSandbox = (await isSandboxAccountSession(sessionId)) === true;
        } catch (err) {
          console.error('[Crisis] sandbox check failed; paging anyway (fail toward paging):', err);
        }
        if (isSandbox) {
          console.log(`[Crisis] SMS page suppressed for sandbox session ${sessionId}`);
          logInterventionAction(sessionId, 'external_api_called', {
            suppressed: 'crisis_sms_alert', reason: 'sandbox', riskScore,
          }).catch(err => console.error('[Crisis] failed to log sandbox SMS suppression:', err));
          return;
        }
        await m.sendCrisisAlert(
          `🚨 AI-Therapist HIGH crisis flag\nSession ${sessionId.substring(0, 16)}… — risk ${riskScore}/100\nhttps://ai-therapist.nathanblatter.com/admin`,
        );
        await logInterventionAction(sessionId, 'crisis_sms_alert', { riskScore });
      })
      .catch(err => console.error('Error sending crisis SMS:', err));

    // Steer the live model into a structured safety assessment.
    try {
      const { sidebandManager } = await import('./sidebandManager.service.js');
      if (sidebandManager.getActiveConnections().includes(sessionId)) {
        await sidebandManager.injectMessage(sessionId, 'system', SAFETY_PROTOCOL_GUIDANCE, false);
        await logInterventionAction(sessionId, 'safety_protocol', { riskScore });
        console.log(`Safety protocol injected for session ${sessionId}`);
      }
    } catch (err) {
      console.error('Error injecting safety protocol:', err);
    }

    if (global.io) {
      global.io.to(`session:${sessionId}`).emit('session:crisis-emergency', {
        severity: 'high',
        riskScore
      });

      void broadcastAdminEventForSession(global.io, 'session:crisis-emergency', {
        sessionId,
        severity: 'high',
        riskScore,
        priority: 'critical',
        message: `CRITICAL: High-risk crisis detected - Immediate attention required`,
        emergencyAt: new Date(),
        requiresImmediateIntervention: true
      }, sessionId);
    }

    await updateMonitoringFrequency(sessionId, 'critical');

    console.log(`HIGH RISK alert sent to admins for session ${sessionId}`);
  } catch (error) {
    console.error('Error executing high risk response:', error);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Update monitoring frequency for session
 */
async function updateMonitoringFrequency(sessionId: string, frequency: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE therapy_sessions
       SET monitoring_frequency = $2
       WHERE session_id = $1`,
      [sessionId, frequency]
    );

    await logInterventionAction(sessionId, 'monitoring_increased', {
      previousFrequency: 'normal',
      newFrequency: frequency
    });

    console.log(`Monitoring frequency updated to ${frequency} for session ${sessionId}`);
  } catch (error) {
    console.error('Error updating monitoring frequency:', error);
  }
}
