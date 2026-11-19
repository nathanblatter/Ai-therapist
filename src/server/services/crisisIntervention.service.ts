import { pool } from '../config/db.js';
import { logInterventionAction, type CrisisSubject } from './crisisDetection.service.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { emitCrisisResources, clearCrisisResourceState } from './crisisResources.js';

// ============================================
// RISK-ADAPTIVE LIVE STEERING (ai-therapist-42)
// ============================================
// When a message's risk score is elevated (but possibly below the crisis-flag
// threshold), inject de-escalation guidance to the MODEL over the sideband as
// an invisible system message — the participant never sees it, but the
// assistant shifts to validation/safety-assessment before a human steps in.

export const STEER_MIN_SCORE = 25;
export const STEER_COOLDOWN_MS = 3 * 60 * 1000;

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
  `direct question (start with ideation — ask whether they are having thoughts of suicide, and use the word "suicide" when you ask), ` +
  `then call the run_risk_check tool with that step, the participant's answer in their own words, ` +
  `and your clinical risk_band. Continue one rung at a time on later turns ` +
  `(ideation, plan, means, timeframe, intent), logging each with run_risk_check, ` +
  `and record protective_factors when they surface. Stay warm and validating between questions — ` +
  `this is an assessment, not an interrogation. ` +
  `Ask the question plainly. Do not say or imply that the participant told you something they did not say, and do not describe their feelings for them.`;

/** Default trigger score: the moderate/medium entry boundary the stage-2 risk
 *  assessor already uses (40-60 = medium/passive ideation in its rubric).
 *  Override with system_config crisis.risk_check_min_score, mirroring how
 *  crisis.risk_model is stored (crisisDetection.resolveRiskModel). */
export const DEFAULT_RISK_CHECK_MIN_SCORE = 40;

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
      riskScore,
      severity,
      channel,
      delivered,
      trigger: 'risk_check_required',
      threshold: minScore,
    });

    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'session:risk-check-required',
        {
          sessionId,
          riskScore,
          severity,
          threshold: minScore,
          delivered,
          requiredAt: new Date(),
        },
        sessionId,
        'summary',
      );
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

export function steeringGuidance(riskScore: number, severity: string): string {
  const base =
    `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
    `Risk signals in this conversation are elevated (score ${riskScore}/100). ` +
    `Slow your pace and keep responses short, warm, and grounded. Prioritize validation and reflective listening over problem-solving. ` +
    `Gently check how the participant is feeling right now.`;
  if (severity === 'high') {
    return (
      base +
      ` Calmly assess their immediate safety, and naturally work the crisis resources from your instructions into the conversation. ` +
      `Stay with them — the research team's monitoring dashboard has been alerted. ` +
      RISK_CHECK_DIRECTIVE
    );
  }
  return base + ` If anything suggests thoughts of self-harm, follow your crisis protocol. ` + RISK_CHECK_DIRECTIVE;
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
  pendingSteers.delete(sessionId);
  riskCheckRequiredAt.delete(sessionId);
  clearCrisisResourceState(sessionId);
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
  `(1) ask directly whether they are having thoughts of suicide right now, and use the word "suicide" when you ask; ` +
  `(2) if yes, ask whether they have thought about how; ` +
  `(3) whether they have access to that method; ` +
  `(4) whether they have a timeframe in mind. ` +
  `Between questions, validate and stay warm — do not interrogate. ` +
  `Include the crisis resources from your instructions directly in your reply — the 988 Suicide & Crisis Lifeline (call or text 988), the Crisis Text Line (text HOME to 741741), and the BYU CAPS crisis line (801-422-3035) — ` +
  `and, if they engage, offer to write out a simple safety plan together in the chat. ` +
  `Do not end the session yourself. Stay with them. ` +
  RISK_CHECK_DIRECTIVE;

// ============================================
// THIRD PARTY AT RISK (ai-therapist-326)
// ============================================
// Owner decision 2026-11-18: a participant reporting SOMEONE ELSE's active
// crisis ("my roommate just texted me that she's going to kill herself
// tonight") flags high and pages staff. The detection side is the assessor's
// `bystander` context at medium or high (crisisDetection analyzeMessageRisk
// `thirdParty`). Everything that reaches a person says so in words, because a
// page that reads like the participant's own crisis sends the on-call to the
// wrong problem:
//   - the page and the dashboard alert carry THIRD_PARTY_PAGE_LABEL;
//   - crisis_events.notes / risk_factors and the intervention rows carry
//     subject 'third_party' (existing JSON and text columns, no migration);
//   - the model is steered to help the participant act for the other person
//     instead of being told to run the participant through the suicide
//     ladder, and the structured ladder is not demanded for that turn.

/** Line added to the on-call page and the dashboard alert. */
export const THIRD_PARTY_PAGE_LABEL =
  'THIRD PARTY AT RISK: the participant is reporting someone else in crisis, not their own.';

const THIRD_PARTY_GUIDANCE_CORE =
  `The participant has just told you that SOMEONE ELSE may be at risk of suicide or is in a crisis right now. ` +
  `The research team's monitoring systems have been alerted. Take it seriously and stay calm. In your reply: ` +
  `acknowledge how frightening this is for them; ` +
  `if the other person may be in immediate danger (a stated plan for now or tonight, an attempt under way, or they cannot be reached after saying something suicidal), ` +
  `say plainly to call 911 now, or campus police or a resident assistant if they are on campus, and to stay with the person or get someone to them if that is safe; ` +
  `say that they can call or text 988 themselves, right now, to get guidance on helping someone else; ` +
  `encourage them not to carry this alone or keep it secret, and to bring in someone who can reach the person (family, a roommate, an RA). ` +
  `Do not question whether the other person means it, and do not run the participant through questions about their own suicidal thoughts as if the risk were theirs. ` +
  `Once the immediate steps are covered, check how the participant is doing: hearing this is heavy, and if they voice thoughts of their own, follow your crisis protocol. ` +
  `Do not end the session yourself. Stay with them.`;

/** Realtime steer for a third party at risk (the resource card tool exists there). */
export const THIRD_PARTY_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  THIRD_PARTY_GUIDANCE_CORE +
  ` Call the show_resource_card tool so crisis lines are on their screen.`;

/** Chat steer for a third party at risk (resources go in the reply). */
export const CHAT_THIRD_PARTY_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  THIRD_PARTY_GUIDANCE_CORE +
  ` Include 911 and the 988 Suicide & Crisis Lifeline (call or text 988) directly in your reply.`;

// ============================================
// RISK TO OTHERS (ai-therapist-330)
// ============================================
// Owner decision 2026-11-18: "bring them down from the ledge and notify
// staff". A credible statement of intent or planning to harm another person
// is flagged and paged exactly as a high self-risk is, labelled as risk to
// others on everything a person reads (same places as a third party at risk),
// and the model gets a de-escalation steer instead of the suicide protocol:
// stay, slow down, ask calmly about what is happening and what they intend,
// no reflex questions about the participant's own suicide, no lecture or
// threat, emergency guidance only when harm is imminent. The suicide ladder
// is not demanded and the 988 resource card is not pushed for these turns.

/** Line added to the on-call page and the dashboard alert. */
export const RISK_TO_OTHERS_PAGE_LABEL =
  'RISK TO OTHERS: the participant is describing thoughts of harming another person, not self-harm.';

/** Steer for thoughts of harming another person (voice and chat: no tools involved). */
export const HARM_TO_OTHERS_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `The participant has described thoughts of harming another person that may be serious, and the research team's monitoring systems have been alerted. ` +
  `Your job now is to bring the temperature down and stay with them. Slow your pace; keep replies short, calm and steady. ` +
  `Acknowledge the anger or hurt underneath without agreeing that anyone deserves to be harmed. ` +
  `Ask, one question at a time and without accusation, what is going on and what they mean: what the thoughts are like, whether they intend to act on them, and whether anything is about to happen. ` +
  `Do not lecture, moralise, argue or threaten consequences. Do not give any help finding, approaching or harming the person, do not ask where that person is, and do not bring up the places the participant mentioned (where the person parks, lives or works) or whether the participant is going there. ` +
  `Do not ask about the participant's own suicidal thoughts by reflex; ask only if they say something that points that way. ` +
  `Help them put distance between the feeling and acting on it: staying away from the person for now, stepping away from anything they could use, something that lets the anger come down, someone they trust to be with. ` +
  `Do not promise secrecy: if they ask, be honest that conversations flagged for safety are reviewed by the research team, which has a duty to act when someone may be in danger. ` +
  `Only if harm seems imminent (they say they are about to act) say plainly that this is an emergency: ask them to stop and step away now and to call 911, or 988 to talk it through. ` +
  `Do not end the session yourself. Stay with them.`;

/** The page / alert label for a subject, or null for the participant's own risk. */
export function subjectLabel(subject: CrisisSubject | null | undefined): string | null {
  return subject === 'third_party'
    ? THIRD_PARTY_PAGE_LABEL
    : subject === 'harm_to_others'
      ? RISK_TO_OTHERS_PAGE_LABEL
      : null;
}

/** The steer that replaces the standard one for a subject, or null. */
export function subjectGuidance(
  subject: CrisisSubject | null | undefined,
  channel: 'realtime' | 'chat',
): string | null {
  return subject === 'third_party'
    ? channel === 'chat'
      ? CHAT_THIRD_PARTY_GUIDANCE
      : THIRD_PARTY_GUIDANCE
    : subject === 'harm_to_others'
      ? HARM_TO_OTHERS_GUIDANCE
      : null;
}

// ============================================
// A STEER EARNED BEFORE THE VOICE SOCKET IS OPEN
// ============================================
// The pre-session check-in is scored at session start. On Grok voice that is
// before the browser has attached and the upstream socket exists, so the steer
// a check-in earns ("I'm going to kill myself tonight" in the form) had no
// socket to travel on and was recorded as undeliverable: the flag and the
// page went out, and the model then opened the conversation with no safety
// guidance at all. A steer that cannot be delivered because there is no live
// connection is now held here and delivered the moment the socket is ready
// (deliverPendingSteer, called by the voice manager once the session is
// configured). One per session, the most serious; dropped after
// PENDING_STEER_TTL_MS, so a steer for something said long ago is never
// replayed into a later reconnect.
export const PENDING_STEER_TTL_MS = 5 * 60 * 1000;

interface PendingSteer {
  text: string;
  riskScore: number;
  severity: string;
  subject: CrisisSubject | null;
  /** 2: the high-severity protocol; 1: an ordinary steer. */
  rank: 1 | 2;
  at: number;
}
const pendingSteers = new Map<string, PendingSteer>();

function holdSteer(sessionId: string, steer: Omit<PendingSteer, 'at'>): void {
  const now = Date.now();
  for (const [id, held] of pendingSteers) {
    if (now - held.at > PENDING_STEER_TTL_MS) pendingSteers.delete(id);
  }
  const held = pendingSteers.get(sessionId);
  if (held && held.rank > steer.rank) return;
  pendingSteers.set(sessionId, { ...steer, at: now });
}

/** Test hook. */
export function _pendingSteerCountForTests(): number {
  return pendingSteers.size;
}

/**
 * Deliver the steer this session earned while it had no live connection, if
 * there is one and it is still fresh. Called by a voice manager when its
 * socket becomes ready. Returns true when a steer was delivered. Never throws.
 */
export async function deliverPendingSteer(sessionId: string): Promise<boolean> {
  const held = pendingSteers.get(sessionId);
  if (!held) return false;
  pendingSteers.delete(sessionId);
  if (Date.now() - held.at > PENDING_STEER_TTL_MS) return false;
  try {
    const { sidebandManager } = await import('./sidebandManager.service.js');
    const delivered = await sidebandManager.tryInject(sessionId, 'system', held.text, false);
    await logInterventionAction(sessionId, held.rank === 2 ? 'safety_protocol' : 'risk_steering', {
      riskScore: held.riskScore,
      severity: held.severity,
      delivered,
      deliveredOn: 'socket_ready',
      heldForMs: Date.now() - held.at,
      ...(held.subject ? { subject: held.subject } : {}),
    });
    if (delivered) steeringLastSent.set(sessionId, Date.now());
    return delivered;
  } catch (error) {
    console.error('[crisis] delivering the held steer failed:', error);
    return false;
  }
}

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
export async function maybeSteerSession(
  sessionId: string,
  riskScore: number,
  severity: string,
  /** Skip the cooldown check. Defaults to the long-standing rule (high
   *  severity always forces); the pipeline passes false for a context-wake
   *  turn in a session already flagged high (see runCrisisPipeline). */
  force: boolean = severity === 'high',
  /** Steer with this text instead of the standard copy (a third party at
   *  risk, or risk to others). The cooldown, the sideband gate and the
   *  logging are unchanged. */
  guidanceOverride: string | null = null,
  /** Recorded on the steering row when an override is used. */
  subject: CrisisSubject | null = null,
): Promise<void> {
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
      // Held for the moment the socket is ready (deliverPendingSteer).
      holdSteer(sessionId, {
        text: guidanceOverride ?? steeringGuidance(riskScore, severity),
        riskScore,
        severity,
        subject: guidanceOverride ? (subject ?? 'third_party') : null,
        rank: 1,
      });
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
          riskScore,
          severity,
          delivered: false,
          reason: 'no_sideband',
        });
      }
      return;
    }

    if (!shouldSteer(sessionId, riskScore, force)) return;

    await sidebandManager.injectMessage(
      sessionId,
      'system',
      guidanceOverride ?? steeringGuidance(riskScore, severity),
      false,
    );
    await logInterventionAction(sessionId, 'risk_steering', {
      riskScore,
      severity,
      delivered: true,
      ...(guidanceOverride ? { subject: subject ?? 'third_party' } : {}),
    });

    if (global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'session:risk-steering',
        {
          sessionId,
          riskScore,
          severity,
          steeredAt: new Date(),
        },
        sessionId,
      );
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
    const guidance = severity === 'high' ? SAFETY_PROTOCOL_GUIDANCE : steeringGuidance(riskScore, severity);
    const injected = await sidebandManager.tryInject(sessionId, 'system', guidance, false);
    if (injected) {
      await logInterventionAction(sessionId, severity === 'high' ? 'safety_protocol' : 'risk_steering', {
        riskScore,
        severity,
        trigger: 'manual_flag',
        flaggedBy,
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

export const CRISIS_WIND_DOWN_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `A human monitor has decided this session should come to a close now. In your next reply: ` +
  `calmly and warmly let the participant know the session is wrapping up (do not say why or mention any monitor); ` +
  `call the show_resource_card tool so crisis lines are on their screen; ` +
  `remind them they can call or text 988 any time, day or night; ` +
  `give a brief, caring goodbye (2-3 sentences, no new topics); then immediately call the end_session tool.`;

export const WIND_DOWN_GRACE_MS = 75 * 1000;

export async function initiateCrisisWindDown(sessionId: string, initiatedBy: string): Promise<{ injected: boolean }> {
  const { sidebandManager } = await import('./sidebandManager.service.js');
  // A wind-down is, by definition, a crisis session being asked to end:
  // grant it, or the end_session tool refuses the model's call.
  const { authorizeModelEnd } = await import('../utils/modelEndAuthorization.js');
  authorizeModelEnd(sessionId);
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
    void hardEndCrisisSession(sessionId, initiatedBy).catch((err) =>
      console.error(`[CrisisWindDown] hard-end failed for ${sessionId}:`, err),
    );
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

/** Who raised a high flag (PR 70). */
export type RiskFlagRaisedBy = 'participant_turn' | 'model_escalation';

export interface GraduatedResponseOptions {
  source?: RiskFlagRaisedBy;
  thirdParty?: boolean;
  subject?: CrisisSubject | null;
  escalation?: 'plan_or_time' | 'attempt' | null;
  alsoSubject?: CrisisSubject | null;
}

/**
 * Execute graduated response based on risk severity.
 * Only 'high' severity triggers a response (admin alert only).
 * @param {string} sessionId - Session ID
 * @param {string} severity - Risk severity ('high' or 'none')
 * @param {number} riskScore - Risk score (0-100)
 * @param source - Where the flag came from. 'model_escalation' (the model's
 *   escalate_to_human tool) only changes what the on-call page says: its
 *   score is the fixed value for that request, not a score of anything the
 *   participant said.
 */
export async function executeGraduatedResponse(
  sessionId: string,
  severity: string,
  riskScore: number,
  /** Either who raised the flag (PR 70: 'participant_turn' by default, or
   *  'model_escalation' for the assistant's escalate tool), or an options
   *  object carrying that and what PR 65 added:
   *  `subject` / `thirdParty`: the flag is not about the participant's own
   *  suicide or self-harm risk (someone else's crisis, or thoughts of harming
   *  another person); the page, the alert and the steer say so.
   *  `escalation`: what the turn says is happening ('plan_or_time' |
   *  'attempt'); the page says it in words and is not folded into a page that
   *  did not. `alsoSubject`: the turn is handled as the participant's own
   *  risk and ALSO concerned someone else; the page mentions it. */
  optionsOrSource: GraduatedResponseOptions | RiskFlagRaisedBy = {},
): Promise<void> {
  const options: GraduatedResponseOptions =
    typeof optionsOrSource === 'string' ? { source: optionsOrSource } : optionsOrSource;
  try {
    if (severity === 'high') {
      await executeHighRiskResponse(
        sessionId,
        riskScore,
        options.source ?? 'participant_turn',
        options.subject ?? (options.thirdParty === true ? 'third_party' : null),
        { escalation: options.escalation ?? null, alsoSubject: options.alsoSubject ?? null },
      );
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
export const SAFETY_PROTOCOL_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `A high-severity safety concern has been detected and the research team's monitoring systems have been alerted. ` +
  `Shift fully into safety assessment, gently and without alarm. One question at a time, in this order, adapting to their answers: ` +
  `(1) ask directly whether they are having thoughts of suicide right now, and use the word "suicide" when you ask; ` +
  `(2) if yes, ask whether they have thought about how; ` +
  `(3) whether they have access to that method; ` +
  `(4) whether they have a timeframe in mind. ` +
  `Between questions, validate and stay warm — do not interrogate. ` +
  `Call the show_resource_card tool so crisis lines are on their screen, and if they engage, offer to build a safety plan together using the create_safety_plan tool. ` +
  `Do not end the session yourself. Stay with them. ` +
  RISK_CHECK_DIRECTIVE;

/**
 * Page the on-call phone with a message that is NOT tied to a therapy session
 * (thread-message alerts: the caller owns its own sandbox short-circuit and
 * its own once-per-message guard). Message copy is the caller's and must
 * already be PHI-free.
 *
 * Session-linked pages do not come through here: they go through
 * crisisPaging.service (pageHighRisk / pageVendorTermination), which owns the
 * sandbox suppression, the per-participant de-duplication across sessions,
 * the wording, and the 'crisis_sms_alert' / suppression rows.
 */
export async function pageOnCall(message: string): Promise<void> {
  const { sendCrisisAlert } = await import('./crisisAlert.service.js');
  await sendCrisisAlert(message);
}

/**
 * Execute high risk intervention: page the on-call phone, alert admin
 * dashboards, and inject the structured safety-assessment protocol into the
 * live model over the sideband.
 */
async function executeHighRiskResponse(
  sessionId: string,
  riskScore: number,
  source: RiskFlagRaisedBy = 'participant_turn',
  subject: CrisisSubject | null = null,
  extra: { escalation?: 'plan_or_time' | 'attempt' | null; alsoSubject?: CrisisSubject | null } = {},
): Promise<void> {
  const subjectDetail = subject ? { subject } : {};
  const pageFacts = {
    source,
    ...subjectDetail,
    ...(extra.escalation ? { escalation: extra.escalation } : {}),
    ...(extra.alsoSubject ? { alsoSubject: extra.alsoSubject } : {}),
  };
  try {
    // Crisis resources to the participant FIRST, before anything that can
    // stall (ai-therapist-293): on GPT-Live the vendor's filter can close the
    // voice session within half a second of the model starting its reply, and
    // the resource card is the one response that does not depend on the
    // session surviving. Deduplicated against the pipeline's own early emit.
    // Not for thoughts of harming someone else: the card is the suicide and
    // crisis lines, and pushing it at someone who is angry at another person
    // is the reflex the de-escalation steer is there to avoid.
    if (subject !== 'harm_to_others') {
      emitCrisisResources(sessionId, { reason: 'high_risk', severity: 'high', riskScore });
    }

    await logInterventionAction(sessionId, 'high_risk_emergency', {
      riskScore,
      emergencyProtocol: 'activated',
      ...pageFacts,
    });

    // Page a human: the dashboard socket alert only works if someone is
    // looking at the dashboard. Fire-and-forget. Whether this becomes an SMS,
    // or is folded into a page the on-call already has for this participant,
    // is crisisPaging.service's decision (sandbox suppression, wording and
    // the audit row live there too). The subject goes with it: the page says
    // who is at risk, and a page about someone else never absorbs one about
    // the participant (or the reverse).
    import('./crisisPaging.service.js')
      .then((m) => m.pageHighRisk(sessionId, riskScore, pageFacts))
      .catch((err) => console.error('Error sending crisis SMS:', err));

    // Steer the live model into a structured safety assessment, or, when the
    // person at risk is someone else, into helping the participant respond.
    try {
      const { sidebandManager } = await import('./sidebandManager.service.js');
      if (sidebandManager.getActiveConnections().includes(sessionId)) {
        await sidebandManager.injectMessage(
          sessionId,
          'system',
          subjectGuidance(subject, 'realtime') ?? SAFETY_PROTOCOL_GUIDANCE,
          false,
        );
        await logInterventionAction(sessionId, 'safety_protocol', {
          riskScore,
          ...subjectDetail,
        });
        console.log(`Safety protocol injected for session ${sessionId}`);
      } else {
        // No live connection yet (a check-in scored before the voice socket
        // opened): held, and delivered when the socket is ready.
        holdSteer(sessionId, {
          text: subjectGuidance(subject, 'realtime') ?? SAFETY_PROTOCOL_GUIDANCE,
          riskScore,
          severity: 'high',
          subject,
          rank: 2,
        });
      }
    } catch (err) {
      console.error('Error injecting safety protocol:', err);
    }

    if (global.io) {
      // The participant's copy of this event went out at the top of this
      // function (emitCrisisResources); what follows is the admin dashboards'.
      void broadcastAdminEventForSession(
        global.io,
        'session:crisis-emergency',
        {
          sessionId,
          severity: 'high',
          riskScore,
          priority: 'critical',
          message: subject
            ? `CRITICAL: High-risk crisis detected - ${subjectLabel(subject)} Immediate attention required`
            : `CRITICAL: High-risk crisis detected - Immediate attention required`,
          ...subjectDetail,
          emergencyAt: new Date(),
          requiresImmediateIntervention: true,
        },
        sessionId,
      );
    }

    await updateMonitoringFrequency(sessionId, 'critical');

    // Our own session timer must not cut them off (ai-therapist-281): lift it
    // to the vendor ceiling. Additive and non-fatal.
    try {
      const [{ liftLimitForCrisis }, { resolveVendorCeilingMinutes }] = await Promise.all([
        import('../utils/sessionAutoTerminate.js'),
        import('../utils/sessionHelpers.js'),
      ]);
      const ceiling = await resolveVendorCeilingMinutes();
      const lift = liftLimitForCrisis(sessionId, ceiling);
      if (lift.lifted) {
        await logInterventionAction(sessionId, 'crisis_timer_extended', {
          riskScore,
          previousLimitMinutes: lift.previousLimitMinutes,
          ceilingMinutes: lift.ceilingMinutes,
        });
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:crisis-timer-extended',
            {
              sessionId,
              previousLimitMinutes: lift.previousLimitMinutes,
              ceilingMinutes: lift.ceilingMinutes,
              extendedAt: new Date(),
            },
            sessionId,
          );
        }
        console.log(
          `Session timer lifted for ${sessionId}: ${lift.previousLimitMinutes} -> ${lift.ceilingMinutes} minutes (crisis)`,
        );
      }
    } catch (err) {
      console.error('Error lifting the session timer for crisis:', err);
    }

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
      [sessionId, frequency],
    );

    await logInterventionAction(sessionId, 'monitoring_increased', {
      previousFrequency: 'normal',
      newFrequency: frequency,
    });

    console.log(`Monitoring frequency updated to ${frequency} for session ${sessionId}`);
  } catch (error) {
    console.error('Error updating monitoring frequency:', error);
  }
}
