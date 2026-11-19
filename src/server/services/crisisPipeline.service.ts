// Shared per-turn crisis pipeline (ai-therapist-105). The orchestration that
// used to be inlined in logs.routes.ts::processInsertedMessages now lives here
// so BOTH the realtime batch endpoint (/logs/batch) and the chat endpoint
// (/api/chat/message) run identical detection / flagging / paging / AE logic.
//
// The `channel` argument controls ONLY steering DELIVERY:
//   - realtime: steering is injected over the sideband (maybeSteerSession),
//     which already happened by the time this returns, so realtime callers
//     ignore `steeringGuidance` (it stays null).
//   - chat: there is no sideband, so the guidance string is returned and the
//     chat route injects it into the very model call that answers this turn
//     (same-turn steering — strictly better than realtime, where guidance
//     lands mid/next turn).
//
// Everything else — risk_score_history writes, crisis flagging, paging via
// sendCrisisAlert, session:crisis-emergency, and the AE auto-draft — is
// channel-agnostic and reuses the existing functions untouched.
import { analyzeMessageRisk, flagSessionCrisis, logInterventionAction } from './crisisDetection.service.js';
import {
  maybeSteerSession,
  maybeRequireRiskCheck,
  shouldSteer,
  buildChatSteeringGuidance,
  executeGraduatedResponse,
  CHAT_SAFETY_PROTOCOL_GUIDANCE,
} from './crisisIntervention.service.js';
import { getRecentSessionMessages, getSessionAccessInfo, getSessionCrisisState } from '../db/index.js';
import { sessionSuppressesSafetyPipeline } from './suppression.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { enqueueWorkItem } from './workQueue.service.js';
import { emitCrisisResources, hasEmittedHighRiskResources } from './crisisResources.js';
import type { MinorVerdict } from './minorSafeguard.service.js';

export interface ParticipantTurn {
  sessionId: string;
  messageId: string | number | null;
  content: string;
}

export type CrisisSeverity = 'none' | 'low' | 'medium' | 'high';

export interface CrisisPipelineResult {
  riskScore: number;
  severity: CrisisSeverity;
  factors: string[];
  flagged: boolean;
  /** Non-null when steering should be delivered to the model this/next turn.
   *  Realtime callers ignore it (sideband injection already happened);
   *  chat callers inject it into the model call. */
  steeringGuidance: string | null;
}

const NONE_RESULT: CrisisPipelineResult = {
  riskScore: 0,
  severity: 'none',
  factors: [],
  flagged: false,
  steeringGuidance: null,
};

const SEVERITY_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Full per-turn crisis pipeline, shared by /logs/batch and /api/chat/message.
 * `channel` controls only steering DELIVERY; detection/flagging/paging/AE are
 * identical. Never throws (analyzeMessageRisk already error-swallows; the rest
 * is wrapped here) — a crisis-pipeline failure must never break either route.
 */
export async function runCrisisPipeline(
  turn: ParticipantTurn,
  channel: 'realtime' | 'chat',
): Promise<CrisisPipelineResult> {
  try {
    // Demo-ACCOUNT (magic-link) sessions never enter the real crisis pipeline:
    // no scoring, no flags, no admin alerts, and crucially no SMS page to the
    // on-call. Keyed on the owner's role, NOT the session is_demo flag — the
    // eval harness's sessions carry is_demo for analytics exclusion but must
    // still exercise the real pipeline (its runner neuters paging/broadcast).
    if (await sessionSuppressesSafetyPipeline(turn.sessionId)) return NONE_RESULT;

    const history = await getRecentSessionMessages(turn.sessionId, 10);

    // Age-eligibility confirmation starts NOW, alongside risk scoring, and is
    // acted on after the crisis block below (ai-therapist-296). On voice the
    // model answers within about half a second, so every second the verdict
    // waits behind the risk assessor is a second the voice model is talking to
    // someone the study cannot include. Only the LLM confirmation is moved
    // forward; the ordering of the ACTIONS (crisis first, then eligibility) is
    // unchanged.
    // A spoken sentence can reach us as two turns. GPT-Live sends transcript
    // fragments, and the assembler closes a turn after 900 ms without one; a
    // late final fragment then becomes a turn of its own. Measured 2026-11-18:
    // "I have been thinking about how I would kill" + " myself" arrived as two
    // rows in 2 of 4 runs, each scored 0 (the keyword screen saw neither
    // half), so an explicit statement of intent was never flagged or paged.
    // Scoring and the age check therefore read the sentence as it was spoken:
    // this turn joined to the participant turn(s) that ended moments before it.
    const stitched =
      channel === 'realtime' ? stitchSplitTurnParts(turn, history) : { content: turn.content, priorMessageIds: [] };
    const scoredTurn = stitched.content === turn.content ? turn : { ...turn, content: stitched.content };

    const minorVerdict = channel === 'realtime' ? startRealtimeMinorConfirmation(scoredTurn, history) : null;

    const risk = await analyzeMessageRisk(
      {
        content: scoredTurn.content,
        session_id: turn.sessionId,
        message_id: turn.messageId ?? undefined,
        // The earlier part(s) of this sentence were scored on their own when
        // they arrived. Their rows are this message, not its run-up: the
        // scorer leaves them out of the trajectory so the sentence is not its
        // own "sudden spike" (a medium statement plus " you know?" scored
        // high, and paged, before this was passed).
        ...(stitched.priorMessageIds.length > 0 ? { stitched_message_ids: stitched.priorMessageIds } : {}),
      },
      history,
    );

    const severity = risk.severity as CrisisSeverity;
    let steeringGuidance: string | null = null;
    let flagged = false;

    // Crisis resources the moment a turn scores high, before steering, the
    // flag write and the intervention logs (ai-therapist-293). Once per
    // session from here: a later escalation re-emits from
    // executeHighRiskResponse exactly as before, so a participant who closed
    // the card is not shown it again on every high turn.
    if (severity === 'high' && !hasEmittedHighRiskResources(turn.sessionId)) {
      emitCrisisResources(turn.sessionId, { reason: 'high_risk', severity: 'high', riskScore: risk.riskScore });
    }

    if (risk.riskScore > 0) {
      // Flag state BEFORE this turn's own flagging: read once, used by both
      // the steering decision and the flagging decision below.
      // A failed read must not cost this turn its steer (the read used to come
      // after steering): steer on the default rule, then let the flagging step
      // fail exactly as it did before.
      let state: Awaited<ReturnType<typeof getSessionCrisisState>> = null;
      let stateError: unknown = null;
      try {
        state = await getSessionCrisisState(turn.sessionId);
      } catch (err) {
        stateError = err;
      }
      // High severity normally forces the safety-protocol steer past the
      // cooldown. The one exception is a context-wake turn (no keyword; scored
      // high only because of what the session already holds) in a session that
      // is ALREADY flagged high: there the protocol has been delivered, and in
      // such a session every short answer ("yes", "tonight") is context-
      // assessed, so forcing would re-inject "start the assessment at question
      // one" on every turn. Those turns steer on the ordinary cooldown. A
      // context-wake turn that ESCALATES the session (anything below high ->
      // high) still forces, as does every keyword-hit turn, exactly as before.
      const alreadyHigh = state?.crisis_flagged === true && state?.crisis_severity === 'high';
      const forceSteer = severity === 'high' && !(risk.contextWake === true && alreadyHigh);

      // Summary-tier live signal (caseworker portal spec section 5): score +
      // severity only — caseworker sockets get risk trends without any
      // transcript content. Fire-and-forget; never blocks the pipeline.
      if (global.io) {
        void broadcastAdminEventForSession(
          global.io,
          'session:risk-score-updated',
          {
            sessionId: turn.sessionId,
            riskScore: risk.riskScore,
            severity,
            at: new Date(),
          },
          turn.sessionId,
          'summary',
        );
      }

      // ---- Steering ----
      if (channel === 'realtime') {
        // Sideband injection happens inside; realtime ignores the return value.
        await maybeSteerSession(turn.sessionId, risk.riskScore, severity, forceSteer);
      } else if (shouldSteer(turn.sessionId, risk.riskScore, forceSteer)) {
        // Chat: same shared cooldown, but the guidance is returned for the
        // caller to inject into this turn's model call. High severity swaps the
        // base copy for the full safety-assessment protocol and mirrors the
        // realtime `safety_protocol` intervention so the AE timeline matches.
        // High severity forces past the cooldown — a crisis escalating within
        // three minutes of a routine steer must still get the safety protocol.
        steeringGuidance =
          severity === 'high' ? CHAT_SAFETY_PROTOCOL_GUIDANCE : buildChatSteeringGuidance(risk.riskScore, severity);
        await logInterventionAction(turn.sessionId, 'risk_steering', {
          riskScore: risk.riskScore,
          severity,
          channel: 'chat',
        });
        if (severity === 'high') {
          await logInterventionAction(turn.sessionId, 'safety_protocol', {
            riskScore: risk.riskScore,
            channel: 'chat',
          });
        }
        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:risk-steering',
            {
              sessionId: turn.sessionId,
              riskScore: risk.riskScore,
              severity,
              steeredAt: new Date(),
            },
            turn.sessionId,
          );
        }
      }

      // ---- Structured risk ladder (ai-therapist-198) ----
      // Independent of the steering cooldown above: the ladder requirement is
      // a one-shot-per-window demand keyed on "score crossed the threshold AND
      // this session has logged no ladder step", not on steering cadence. It
      // runs on both channels; realtime delivers over the sideband inside,
      // chat gets a guidance string appended to this turn's model call.
      const ladderGuidance = await maybeRequireRiskCheck(turn.sessionId, risk.riskScore, severity, channel);
      if (ladderGuidance) {
        steeringGuidance = steeringGuidance ? `${steeringGuidance}\n\n${ladderGuidance}` : ladderGuidance;
      }

      // ---- Flagging ---- (identical to the original realtime logic)
      if (stateError) throw stateError;
      const currentScore = state?.crisis_risk_score || 0;
      const shouldFlag =
        (severity === 'high' || severity === 'medium') &&
        (!state?.crisis_flagged ||
          SEVERITY_RANK[severity] > (SEVERITY_RANK[state?.crisis_severity ?? 'none'] ?? 0) ||
          risk.riskScore > currentScore + 10);

      if (shouldFlag) {
        await flagSessionCrisis(
          turn.sessionId,
          severity,
          risk.riskScore,
          'system',
          'auto',
          turn.messageId ?? null,
          risk.factors,
          `Risk score: ${risk.riskScore} - Factors: ${risk.factors.join(', ')}`,
        );

        await logInterventionAction(turn.sessionId, 'auto_flag', {
          riskScore: risk.riskScore,
          severity,
          messageId: turn.messageId,
          factors: risk.factors,
        });

        if (global.io) {
          void broadcastAdminEventForSession(
            global.io,
            'session:crisis-detected',
            {
              sessionId: turn.sessionId,
              severity,
              riskScore: risk.riskScore,
              factors: risk.factors,
              messageId: turn.messageId,
              detectedAt: new Date(),
              message: `${severity.toUpperCase()} risk detected (score: ${risk.riskScore})`,
              ...(channel === 'chat' ? { sessionType: 'chat' } : {}),
            },
            turn.sessionId,
          );

          // Summary-tier mirror for caseworker sockets (spec section 5:
          // crisis-event-created is summary-safe). Severity/score/category
          // factors only — no message ids, no transcript-adjacent text.
          void broadcastAdminEventForSession(
            global.io,
            'session:crisis-event-created',
            {
              sessionId: turn.sessionId,
              severity,
              riskScore: risk.riskScore,
              factors: risk.factors,
              detectedAt: new Date(),
            },
            turn.sessionId,
            'summary',
          );
        }

        await executeGraduatedResponse(turn.sessionId, severity, risk.riskScore);
        flagged = true;

        // Work-queue hook (caseworker portal): pool item for the client's care
        // team. Only sessions with a logged-in participant enqueue — anonymous
        // sessions have no care team (a null-client item would fall back to
        // the IRB org as pure noise), and demo-account sessions never reach
        // this code (guarded at the top of the pipeline). `reopen` reactivates
        // a resolved/expired item on a re-flag at the same severity, so a
        // recurrence after resolution notifies the care team again instead of
        // dying on the idempotency key; while the item is open/acked a
        // same-severity re-flag stays a silent no-op (no duplicate spam).
        // enqueueWorkItem never throws and resolves client/org/sandbox from
        // the session; detail carries category tags only, never transcript.
        try {
          const sessionInfo = await getSessionAccessInfo(turn.sessionId);
          if (sessionInfo?.user_id != null) {
            void enqueueWorkItem({
              itemType: 'crisis_flag',
              severity: 'urgent',
              title: `Crisis flag: ${severity} risk (score ${risk.riskScore})`,
              detail: { severity, risk_score: risk.riskScore, factors: risk.factors },
              sourceTable: 'therapy_sessions',
              sourceId: `${turn.sessionId}:${severity}`,
              sessionId: turn.sessionId,
              reopen: true,
            });
          }
        } catch (err) {
          console.error('[CrisisPipeline] work-item enqueue guard failed (non-fatal):', err);
        }

        console.log(`Session ${turn.sessionId} flagged as ${severity} risk (score: ${risk.riskScore}, ${channel})`);
      } else if (severity === 'high' && alreadyHigh) {
        // A high turn that the re-flag rule above let pass. Correct when the
        // stored high flag came from the participant (the on-call was paged
        // for it). Not when it is only the recovery-continuation stamp, which
        // is written at the inherited score, or at 100: nothing said in a
        // recovery session could then ever flag or page. crisisPaging.service
        // tells the two apart and applies the usual folding. Fire-and-forget,
        // like the page in executeHighRiskResponse; no flag, no second
        // adverse-event draft, no steering change.
        import('./crisisPaging.service.js')
          .then((m) => m.pageHighTurnWithoutReflag(turn.sessionId, risk.riskScore))
          .catch((err) => console.error('[CrisisPipeline] page for a high turn without re-flag failed:', err));
      }
    }

    // ---- Minor / age-eligibility safeguard (ai-therapist-106) ----
    // Realtime only: the chat route runs this gate itself (before its model
    // call) so it can return a server-authored goodbye. ACTED ON after the
    // crisis block so, when a turn is both high-crisis and minor-confirmed, the
    // page has already gone out and both AE drafts exist; the goodbye copy
    // carries the hotlines. Independent of risk score (e.g. "I'm 15" scores 0).
    // The confirmation itself was started before risk scoring (above).
    if (minorVerdict) {
      await applyRealtimeMinorVerdict(turn, await minorVerdict);
    }

    return { riskScore: risk.riskScore, severity, factors: risk.factors, flagged, steeringGuidance };
  } catch (err) {
    console.error('[CrisisPipeline] pipeline failed (non-fatal):', err);
    return NONE_RESULT;
  }
}

/** A participant turn that ended this recently before the next one began is
 *  treated as the first part of the same spoken sentence. */
export const SPLIT_TURN_WINDOW_MS = 4_000;

/**
 * The text to score for a voice turn: the turn itself, prefixed with any
 * participant turn(s) persisted immediately before it (no assistant turn in
 * between) and within SPLIT_TURN_WINDOW_MS of each other. Fragments carry
 * their own spacing, so the parts are concatenated exactly as received.
 *
 * `history` is oldest-first and normally ends with this turn's own row (it is
 * persisted before the pipeline runs). When the row cannot be found (the
 * insert failed), nothing is stitched. Pure; exported for tests.
 */
export function stitchSplitTurn(
  turn: ParticipantTurn,
  history: Array<{ role: string; content?: string | null; message_id?: unknown; created_at?: unknown }>,
): string {
  return stitchSplitTurnParts(turn, history).content;
}

/**
 * stitchSplitTurn, plus the ids of the earlier turn(s) that were joined in
 * (oldest first; empty when nothing was stitched). Pure; exported for tests.
 */
export function stitchSplitTurnParts(
  turn: ParticipantTurn,
  history: Array<{ role: string; content?: string | null; message_id?: unknown; created_at?: unknown }>,
): { content: string; priorMessageIds: Array<string | number> } {
  const alone = { content: turn.content, priorMessageIds: [] as Array<string | number> };
  if (turn.messageId == null) return alone;
  const at = history.findIndex((m) => m.message_id != null && String(m.message_id) === String(turn.messageId));
  if (at <= 0) return alone;
  const time = (m: { created_at?: unknown }): number | null => {
    const t = m.created_at instanceof Date ? m.created_at.getTime() : Date.parse(String(m.created_at ?? ''));
    return Number.isFinite(t) ? t : null;
  };
  let text = turn.content;
  const priorMessageIds: Array<string | number> = [];
  let laterAt = time(history[at]);
  for (let i = at - 1; i >= 0 && at - i <= 3; i--) {
    const prev = history[i];
    const prevAt = time(prev);
    if (prev.role !== 'user' || !prev.content || laterAt == null || prevAt == null) break;
    if (laterAt - prevAt > SPLIT_TURN_WINDOW_MS || laterAt < prevAt) break;
    text = prev.content + text;
    if (typeof prev.message_id === 'string' || typeof prev.message_id === 'number') {
      priorMessageIds.unshift(prev.message_id);
    }
    laterAt = prevAt;
  }
  return { content: text, priorMessageIds };
}

/**
 * When the under-18 goodbye guidance was last DELIVERED to a session's voice
 * model. A failed delivery is not recorded, so a later confirmation tries
 * again. Entries outlive the session's forced end (60 s) and are then dropped.
 */
const MINOR_GOODBYE_REPEAT_GUARD_MS = 90_000;
const minorGoodbyeDeliveredAt = new Map<string, number>();

function minorGoodbyeRecentlyDelivered(sessionId: string, now = Date.now()): boolean {
  for (const [id, at] of minorGoodbyeDeliveredAt) {
    if (now - at > MINOR_GOODBYE_REPEAT_GUARD_MS) minorGoodbyeDeliveredAt.delete(id);
  }
  return minorGoodbyeDeliveredAt.has(sessionId);
}

/** Test hook. */
export function _resetMinorGoodbyeStateForTests(): void {
  minorGoodbyeDeliveredAt.clear();
}

/** How many times the stage-2 confirmation is attempted before failing open. */
const MINOR_CONFIRM_ATTEMPTS = 2;

/**
 * Realtime minor safeguard, part 1: pattern screen, then the LLM confirmation.
 * Resolves to the verdict, or null when the screen did not match or the
 * confirmation could not be obtained. Never rejects, so it can run alongside
 * risk scoring without an unhandled rejection.
 *
 * Fail-open is unchanged: no verdict means the session continues (this gate
 * ENDS sessions, so it must not fire on a guess). What changed is that one
 * transient API error no longer decides that: the call is tried twice.
 */
async function startRealtimeMinorConfirmation(
  turn: ParticipantTurn,
  history: Awaited<ReturnType<typeof getRecentSessionMessages>>,
): Promise<MinorVerdict | null> {
  try {
    const { detectMinorDisclosurePatterns, confirmMinorDisclosure } = await import('./minorSafeguard.service.js');
    if (!detectMinorDisclosurePatterns(turn.content).matched) return null;

    const short = turn.sessionId.substring(0, 12);
    for (let attempt = 1; attempt <= MINOR_CONFIRM_ATTEMPTS; attempt++) {
      try {
        const verdict = await confirmMinorDisclosure(turn.content, history, turn.sessionId);
        // The verdict decides whether a session ends; before this line it was
        // invisible on the voice path, so a miss could not be told apart from
        // a wiring gap (ai-therapist-296). No transcript text, only the verdict.
        console.log(
          `[MinorSafeguard] realtime stage-2 verdict for ${short}...: ` +
            `is_minor=${verdict.isMinor} confidence=${verdict.confidence} stated_age=${verdict.statedAge ?? 'null'}` +
            (attempt > 1 ? ` (attempt ${attempt})` : ''),
        );
        return verdict;
      } catch (err) {
        console.error(
          `[MinorSafeguard] realtime stage-2 confirmation failed for ${short}... ` +
            `(attempt ${attempt}/${MINOR_CONFIRM_ATTEMPTS})` +
            (attempt === MINOR_CONFIRM_ATTEMPTS ? '; failing open, the session continues' : ''),
          err,
        );
      }
    }
    return null;
  } catch (err) {
    // Fail-open: an eligibility confirmation error must never end a session.
    console.error('[MinorSafeguard] realtime safeguard failed (fail-open):', err);
    return null;
  }
}

/**
 * Realtime minor safeguard, part 2: on a confirmed verdict, tell the live model
 * to say the goodbye and run the shared teardown (the browser is told to end,
 * and the server force-ends after a grace). Never throws.
 *
 * The steer and the teardown are independent on purpose. Before, a failed
 * steer (a sideband that had just dropped) threw past handleConfirmedMinor,
 * so a confirmed under-18 disclosure ended nothing and logged nothing.
 */
async function applyRealtimeMinorVerdict(turn: ParticipantTurn, verdict: MinorVerdict | null): Promise<void> {
  if (!verdict) return;
  try {
    if (verdict.isMinor && verdict.confidence !== 'low') {
      const { handleConfirmedMinor, REALTIME_MINOR_GUIDANCE, REALTIME_MINOR_SPEAK_NOW } = await import(
        './minorSafeguard.service.js'
      );
      try {
        const { sidebandManager } = await import('./sidebandManager.service.js');
        if (minorGoodbyeRecentlyDelivered(turn.sessionId)) {
          // The goodbye is being spoken (or was just spoken). The guidance
          // tells the model "do not finish whatever you were saying before",
          // so delivering it a second time would cut the goodbye off and start
          // it again. A second confirmation is routine on voice: a trailing
          // fragment ("... Is that okay?") arrives as its own turn and is
          // checked together with the sentence before it (stitchSplitTurn).
          console.log(
            `[MinorSafeguard] goodbye guidance already delivered for ${turn.sessionId.substring(0, 12)}...; not repeated`,
          );
        } else if (sidebandManager.getActiveConnections().includes(turn.sessionId)) {
          await sidebandManager.injectMessage(
            turn.sessionId,
            'system',
            `${REALTIME_MINOR_GUIDANCE} ${REALTIME_MINOR_SPEAK_NOW}`,
            false,
          );
          minorGoodbyeDeliveredAt.set(turn.sessionId, Date.now());
        } else {
          console.error(
            `[MinorSafeguard] no live sideband for ${turn.sessionId.substring(0, 12)}...: ` +
              'the goodbye guidance was not delivered; ending the session anyway',
          );
        }
      } catch (err) {
        console.error('[MinorSafeguard] goodbye guidance could not be delivered; ending the session anyway:', err);
      }
      await handleConfirmedMinor({
        sessionId: turn.sessionId,
        messageId: turn.messageId ?? null,
        channel: 'realtime',
        statedAge: verdict.statedAge,
      });
    } else if (verdict.isMinor && verdict.confidence === 'low' && global.io) {
      void broadcastAdminEventForSession(
        global.io,
        'session:eligibility-review',
        {
          sessionId: turn.sessionId,
          statedAge: verdict.statedAge,
          reasoning: verdict.reasoning,
          channel: 'realtime',
          at: new Date(),
        },
        turn.sessionId,
      );
    }
  } catch (err) {
    // Fail-open: an eligibility handling error must never break the pipeline.
    console.error('[MinorSafeguard] realtime safeguard failed (fail-open):', err);
  }
}
