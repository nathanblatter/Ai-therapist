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

// ============================================
// STRUCTURED RISK LADDER (ai-therapist-198)
// ============================================
// The run_risk_check tool (toolRegistry) is the highest-quality risk instrument
// in the system, but until now nothing ever told the model to reach for it: the
// steering copy described the C-SSRS ladder in prose and never named the tool,
// so it fired twice in the platform's lifetime. Every elevated-risk steer now
// names the tool explicitly, and the pipeline additionally forces the ask when
// a session crosses the configured score with no ladder logged.

/** Sentence appended to every elevated-risk steer so the tool is always named. */
const RISK_CHECK_DIRECTIVE =
  `As you ask each safety question, call the run_risk_check tool once per answer ` +
  `(step = ideation | plan | means | timeframe | intent, or protective_factors) to log it. ` +
  `This is required whenever risk is moderate or above and no ladder has been completed in this session; ` +
  `it is silent to the participant and does not replace anything you would otherwise say.`;

/** Hard requirement injected by the deterministic trigger (see maybeRequireRiskCheck). */
export const RISK_CHECK_REQUIRED_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `Risk in this session has reached the level that requires a structured safety assessment, ` +
  `and no assessment ladder has been logged yet. On this turn, begin the ladder: ask ONE gentle, ` +
  `direct question (start with ideation — whether they are having thoughts of ending their life), ` +
  `then call the run_risk_check tool with that step, the participant's answer in their own words, ` +
  `and your clinical risk_band. Continue one rung at a time on later turns ` +
  `(ideation, plan, means, timeframe, intent), logging each with run_risk_check, ` +
  `and record protective_factors when they surface. Stay warm and validating between questions — ` +
  `this is an assessment, not an interrogation.`;

/** Default trigger score: the moderate/medium entry boundary the stage-2 risk
 *  assessor already uses (40-60 = medium/passive ideation in its rubric).
 *  Override with system_config crisis.risk_check_min_score, mirroring how
 *  crisis.risk_model is stored (crisisDetection.resolveRiskModel). */
const DEFAULT_RISK_CHECK_MIN_SCORE = 40;

/** Once required, don't re-require for this long — the model needs turns to
 *  work the ladder, and a re-steer every risky turn would both nag the model
 *  and spam intervention_actions. Cleared when the ladder actually starts. */
const RISK_CHECK_RETRY_MS = 5 * 60 * 1000;
const riskCheckRequiredAt = new Map<string, number>();

export async function resolveRiskCheckMinScore(): Promise<number> {
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const config = await getSystemConfig();
    const crisis = config.crisis as { risk_check_min_score?: unknown } | undefined;
    const raw = crisis?.risk_check_min_score;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
    return DEFAULT_RISK_CHECK_MIN_SCORE;
  } catch {
    return DEFAULT_RISK_CHECK_MIN_SCORE;
  }
}

/** Test hook: number of sessions currently holding a risk-check requirement. */
export function _riskCheckRequiredCountForTests(): number {
  return riskCheckRequiredAt.size;
}

/**
 * Deterministic risk-ladder trigger (ai-therapist-198). When a turn scores at
 * or above the configured threshold and the session has logged no ladder step,
 * require the ladder on the next turn: realtime gets a sideband injection here,
 * chat gets the guidance string back for the caller to append to its model
 * call. Either way the attempt is recorded in intervention_actions the way
 * risk_steering is, so "we asked for a ladder and never got one" is countable
 * rather than invisible.
 *
 * Returns the guidance for the chat channel to inject, or null (realtime, or
 * no requirement this turn). Never throws.
 */
export async function maybeRequireRiskCheck(
  sessionId: string,
  riskScore: number,
  severity: string,
  channel: 'realtime' | 'chat',
): Promise<string | null> {
  try {
    const minScore = await resolveRiskCheckMinScore();
    if (riskScore < minScore) return null;

    const lastRequired = riskCheckRequiredAt.get(sessionId) ?? 0;
    if (Date.now() - lastRequired < RISK_CHECK_RETRY_MS) return null;

    const { sessionHasRiskCheck } = await import('../db/index.js');
    if (await sessionHasRiskCheck(sessionId)) {
      // The ladder is underway — the tool description and the steering copy
      // carry it from here; drop any pending requirement marker.
      riskCheckRequiredAt.delete(sessionId);
      return null;
    }

    riskCheckRequiredAt.set(sessionId, Date.now());
    if (riskCheckRequiredAt.size > 500) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [id, ts] of riskCheckRequiredAt) {
        if (ts < cutoff) riskCheckRequiredAt.delete(id);
      }
    }

    let delivered = true;
    if (channel === 'realtime') {
      const { sidebandManager } = await import('./sidebandManager.service.js');
      delivered = await sidebandManager.tryInject(sessionId, 'system', RISK_CHECK_REQUIRED_GUIDANCE, false);
    }

    await logInterventionAction(sessionId, 'risk_steering', {
      riskScore, severity, channel, delivered,
      trigger: 'risk_check_required',
      threshold: minScore,
    });

    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'session:risk-check-required', {
        sessionId, riskScore, severity, threshold: minScore, delivered, requiredAt: new Date(),
      }, sessionId, 'summary');
    }

    return channel === 'chat' ? RISK_CHECK_REQUIRED_GUIDANCE : null;
  } catch (error) {
    // Safety-adjacent but strictly additive: never break the pipeline over it.
    console.error('[crisis] risk-check requirement failed (non-fatal):', error);
    return null;
  }
}
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
      `Stay with them — the research team's monitoring dashboard has been alerted. ` +
      RISK_CHECK_DIRECTIVE;
  }
  return base +
    ` If anything suggests thoughts of self-harm, follow your crisis protocol. ` +
    RISK_CHECK_DIRECTIVE;
}

/**
 * Check-and-consume the steering gate for a session: true means steering should
 * fire now (score at/above threshold AND cooldown elapsed), and the cooldown is
 * marked consumed. Shared by the realtime sideband path and the chat pipeline
 * so a session steers at most once per cooldown window across channels.
 */
export function shouldSteer(sessionId: string, riskScore: number, force = false): boolean {
  if (riskScore < STEER_MIN_SCORE) return false;

  const last = steeringLastSent.get(sessionId) ?? 0;
  // `force` (high severity) skips the cooldown check but still consumes the
  // window: a high-severity safety protocol must never be suppressed by an
  // earlier low-level steer (IRB audit 2026-09-04).
  if (!force && Date.now() - last < STEER_COOLDOWN_MS) return false;

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
  riskCheckRequiredAt.delete(sessionId);
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
    `If anything suggests thoughts of self-harm, follow your crisis protocol and include the crisis resources from your instructions in your reply. ` +
    RISK_CHECK_DIRECTIVE
  );
}

/** Chat-channel high-severity safety-protocol guidance (mirrors the realtime
 *  SAFETY_PROTOCOL_GUIDANCE, but delivers resources in-reply rather than via
 *  client tools). */
export const CHAT_SAFETY_PROTOCOL_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `A high-severity safety concern has been detected and the research team's monitoring systems have been alerted. ` +
  `Shift fully into safety assessment, gently and without alarm. One question at a time, in this order, adapting to their answers: ` +
  `(1) ask directly whether they are having thoughts of ending their life right now; ` +
  `(2) if yes, ask whether they have thought about how; ` +
  `(3) whether they have access to that method; ` +
  `(4) whether they have a timeframe in mind. ` +
  `Between questions, validate and stay warm — do not interrogate. ` +
  `Include the crisis resources from your instructions directly in your reply — the 988 Suicide & Crisis Lifeline (call or text 988), the Crisis Text Line (text HOME to 741741), and the BYU CAPS crisis line (801-422-3035) — ` +
  `and, if they engage, offer to write out a simple safety plan together in the chat. ` +
  `Do not end the session yourself. Stay with them. ` +
  RISK_CHECK_DIRECTIVE;

// Sessions already recorded as having undeliverable steering. Keeps the signal
// to one row per session rather than one per risky turn, while still making the
// session countable.
const steeringSuppressed = new Set<string>();

/** Test hook: number of sessions currently holding a suppression marker. */
export function _suppressedSteeringCountForTests(): number {
  return steeringSuppressed.size;
}

/**
 * Inject de-escalation guidance when risk is elevated. Per-session cooldown so
 * a rough patch doesn't flood the model with repeated guidance.
 *
 * When the session has no live sideband the guidance CANNOT be delivered. That
 * used to be a bare `return` — completely invisible. It is safety-relevant: the
 * risk score still records and the dashboard still alerts, so an audit of "did
 * we intervene?" would silently overcount while the live conversation was never
 * steered at all. Now recorded as an undelivered risk_steering action (once per
 * session) so delivery rate is measurable rather than assumed.
 */
export async function maybeSteerSession(sessionId: string, riskScore: number, severity: string): Promise<void> {
  try {
    if (riskScore < STEER_MIN_SCORE) return;

    // Sideband gate FIRST so the shared cooldown is only consumed when there is
    // actually a live connection to inject into (preserves realtime behavior).
    const { sidebandManager } = await import('./sidebandManager.service.js');
    // isConnected(), not getActiveConnections(). The latter is map membership,
    // and a session is in the map from the moment connect() is called until the
    // socket's 'close' fires — so it reports true while the socket is still
    // CONNECTING or already CLOSING. In those windows shouldSteer would consume
    // the per-session cooldown and injectMessage would then throw (sendEvent
    // requires readyState OPEN), leaving the steer recorded as neither
    // delivered nor undelivered, and the cooldown spent.
    if (!sidebandManager.isConnected(sessionId)) {
      if (!steeringSuppressed.has(sessionId)) {
        steeringSuppressed.add(sessionId);
        // Bounded so a long-lived process can't grow this without limit.
        if (steeringSuppressed.size > 2000) {
          for (const id of steeringSuppressed) {
            if (steeringSuppressed.size <= 1000) break;
            steeringSuppressed.delete(id);
          }
        }
        console.warn(
          `[crisis] risk steering UNDELIVERABLE for ${sessionId.substring(0, 12)}… ` +
          `(score ${riskScore}, ${severity}) — no live sideband connection`,
        );
        await logInterventionAction(sessionId, 'risk_steering', {
          riskScore, severity, delivered: false, reason: 'no_sideband',
        });
      }
      return;
    }

    if (!shouldSteer(sessionId, riskScore, severity === 'high')) return;

    await sidebandManager.injectMessage(sessionId, 'system', steeringGuidance(riskScore, severity), false);
    await logInterventionAction(sessionId, 'risk_steering', { riskScore, severity, delivered: true });

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
  // The trailing `true` (respond-now) is INERT under GPT-Live and kept only for
  // signature compatibility. Realtime could force a reply with response.create;
  // GPT-Live decides for itself when to speak, and an appended instruction can
  // already interrupt speech in progress. Practically this means wind-down
  // guidance is delivered but the model may finish its current sentence first —
  // which is why WIND_DOWN_GRACE_MS exists rather than an immediate cut.
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
  `A high-severity safety concern has been detected and the research team's monitoring systems have been alerted. ` +
  `Shift fully into safety assessment, gently and without alarm. One question at a time, in this order, adapting to their answers: ` +
  `(1) ask directly whether they are having thoughts of ending their life right now; ` +
  `(2) if yes, ask whether they have thought about how; ` +
  `(3) whether they have access to that method; ` +
  `(4) whether they have a timeframe in mind. ` +
  `Between questions, validate and stay warm — do not interrogate. ` +
  `Call the show_resource_card tool so crisis lines are on their screen, and if they engage, offer to build a safety plan together using the create_safety_plan tool. ` +
  `Do not end the session yourself. Stay with them. ` +
  RISK_CHECK_DIRECTIVE;

/**
 * Page the on-call phone. THE single paging choke point for high-severity
 * crisis signals (session pipeline and thread-message scans). Message copy is
 * the caller's — it must already be PHI-free.
 *
 * With a `session` option, the session-linked policy applies: sandbox-owned
 * sessions (synthetic demo caseloads, spec s7 #3) NEVER page the on-call —
 * the suppression is logged, but dashboard emits / sideband steering at the
 * caller stay ON, that being the product demoed. ('crisis_sms_suppressed_
 * sandbox' is not in the intervention_actions CHECK (054), so the suppression
 * rides 'external_api_called' with a detail payload.) A real page is followed
 * by a 'crisis_sms_alert' intervention log.
 *
 * FAIL TOWARD PAGING: the page is only suppressed on an affirmative
 * sandbox=true. A transient throw from the sandbox lookup (or from any
 * suppression logging) must never swallow a REAL page, so the check is
 * isolated in its own try/catch and the suppression log stays out of the
 * paging critical path entirely (fire-and-forget).
 *
 * Without `session` (e.g. thread-message alerts, which have no therapy
 * session to link), the message is sent as-is with no suppression check or
 * intervention log — the caller owns its own sandbox short-circuit.
 */
export async function pageOnCall(
  message: string,
  session?: { sessionId: string; riskScore: number },
): Promise<void> {
  const { sendCrisisAlert } = await import('./crisisAlert.service.js');
  if (!session) {
    await sendCrisisAlert(message);
    return;
  }
  const { sessionId, riskScore } = session;
  let suppressed = false;
  try {
    const { sessionSuppressesCrisisPaging } = await import('./suppression.js');
    suppressed = (await sessionSuppressesCrisisPaging(sessionId)) === true;
  } catch (err) {
    console.error('[Crisis] sandbox check failed; paging anyway (fail toward paging):', err);
  }
  if (suppressed) {
    console.log(`[Crisis] SMS page suppressed for sandbox session ${sessionId}`);
    logInterventionAction(sessionId, 'external_api_called', {
      suppressed: 'crisis_sms_alert', reason: 'sandbox', riskScore,
    }).catch(err => console.error('[Crisis] failed to log sandbox SMS suppression:', err));
    return;
  }
  await sendCrisisAlert(message);
  await logInterventionAction(sessionId, 'crisis_sms_alert', { riskScore });
}

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
    // looking at the dashboard. Fire-and-forget; suppression/logging policy
    // lives in pageOnCall.
    // Deep-link straight to the session (AdminApp reads #session=<id> on
    // load); APP_BASE_URL keeps the link pointed at the right environment.
    const adminBase = (process.env.APP_BASE_URL ?? 'https://ai-therapist.nathanblatter.com')
      .trim().replace(/\/+$/, '');
    pageOnCall(
      `URGENT: AI-Therapist HIGH crisis flag\nSession ${sessionId.substring(0, 16)}… — risk ${riskScore}/100\n${adminBase}/admin#session=${encodeURIComponent(sessionId)}`,
      { sessionId, riskScore },
    ).catch(err => console.error('Error sending crisis SMS:', err));

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
