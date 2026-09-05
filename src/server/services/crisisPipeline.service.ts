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
import {
  analyzeMessageRisk,
  flagSessionCrisis,
  logInterventionAction,
} from './crisisDetection.service.js';
import {
  maybeSteerSession,
  shouldSteer,
  buildChatSteeringGuidance,
  executeGraduatedResponse,
  CHAT_SAFETY_PROTOCOL_GUIDANCE,
} from './crisisIntervention.service.js';
import {
  getRecentSessionMessages,
  getSessionAccessInfo,
  getSessionCrisisState,
} from '../db/index.js';
import { sessionSuppressesSafetyPipeline } from './suppression.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';
import { enqueueWorkItem } from './workQueue.service.js';

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

    const risk = await analyzeMessageRisk(
      { content: turn.content, session_id: turn.sessionId, message_id: turn.messageId ?? undefined },
      history,
    );

    const severity = risk.severity as CrisisSeverity;
    let steeringGuidance: string | null = null;
    let flagged = false;

    if (risk.riskScore > 0) {
      // Summary-tier live signal (caseworker portal spec section 5): score +
      // severity only — caseworker sockets get risk trends without any
      // transcript content. Fire-and-forget; never blocks the pipeline.
      if (global.io) {
        void broadcastAdminEventForSession(global.io, 'session:risk-score-updated', {
          sessionId: turn.sessionId,
          riskScore: risk.riskScore,
          severity,
          at: new Date(),
        }, turn.sessionId, 'summary');
      }

      // ---- Steering ----
      if (channel === 'realtime') {
        // Sideband injection happens inside; realtime ignores the return value.
        await maybeSteerSession(turn.sessionId, risk.riskScore, severity);
      } else if (shouldSteer(turn.sessionId, risk.riskScore, severity === 'high')) {
        // Chat: same shared cooldown, but the guidance is returned for the
        // caller to inject into this turn's model call. High severity swaps the
        // base copy for the full safety-assessment protocol and mirrors the
        // realtime `safety_protocol` intervention so the AE timeline matches.
        // High severity forces past the cooldown — a crisis escalating within
        // three minutes of a routine steer must still get the safety protocol.
        steeringGuidance = severity === 'high'
          ? CHAT_SAFETY_PROTOCOL_GUIDANCE
          : buildChatSteeringGuidance(risk.riskScore, severity);
        await logInterventionAction(turn.sessionId, 'risk_steering', {
          riskScore: risk.riskScore, severity, channel: 'chat',
        });
        if (severity === 'high') {
          await logInterventionAction(turn.sessionId, 'safety_protocol', {
            riskScore: risk.riskScore, channel: 'chat',
          });
        }
        if (global.io) {
          void broadcastAdminEventForSession(global.io, 'session:risk-steering', {
            sessionId: turn.sessionId,
            riskScore: risk.riskScore,
            severity,
            steeredAt: new Date(),
          }, turn.sessionId);
        }
      }

      // ---- Flagging ---- (identical to the original realtime logic)
      const state = await getSessionCrisisState(turn.sessionId);
      const currentScore = state?.crisis_risk_score || 0;
      const shouldFlag = (severity === 'high' || severity === 'medium') &&
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
          void broadcastAdminEventForSession(global.io, 'session:crisis-detected', {
            sessionId: turn.sessionId,
            severity,
            riskScore: risk.riskScore,
            factors: risk.factors,
            messageId: turn.messageId,
            detectedAt: new Date(),
            message: `${severity.toUpperCase()} risk detected (score: ${risk.riskScore})`,
            ...(channel === 'chat' ? { sessionType: 'chat' } : {}),
          }, turn.sessionId);

          // Summary-tier mirror for caseworker sockets (spec section 5:
          // crisis-event-created is summary-safe). Severity/score/category
          // factors only — no message ids, no transcript-adjacent text.
          void broadcastAdminEventForSession(global.io, 'session:crisis-event-created', {
            sessionId: turn.sessionId,
            severity,
            riskScore: risk.riskScore,
            factors: risk.factors,
            detectedAt: new Date(),
          }, turn.sessionId, 'summary');
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
      }
    }

    // ---- Minor / age-eligibility safeguard (ai-therapist-106) ----
    // Realtime only: the chat route runs this gate itself (before its model
    // call) so it can return a server-authored goodbye. Runs AFTER the crisis
    // block so, when a turn is both high-crisis and minor-confirmed, the page
    // has already gone out and both AE drafts exist; the goodbye copy carries
    // the hotlines. Independent of risk score (e.g. "I'm 15" scores 0).
    if (channel === 'realtime') {
      await runRealtimeMinorSafeguard(turn);
    }

    return { riskScore: risk.riskScore, severity, factors: risk.factors, flagged, steeringGuidance };
  } catch (err) {
    console.error('[CrisisPipeline] pipeline failed (non-fatal):', err);
    return NONE_RESULT;
  }
}

/**
 * Realtime minor safeguard: pattern screen → LLM confirm → on confirmation,
 * inject the goodbye guidance to the live model over the sideband and run the
 * shared teardown (60s grace before force-end). Fail-open and never throws.
 */
async function runRealtimeMinorSafeguard(turn: ParticipantTurn): Promise<void> {
  try {
    const {
      detectMinorDisclosurePatterns, confirmMinorDisclosure, handleConfirmedMinor, REALTIME_MINOR_GUIDANCE,
    } = await import('./minorSafeguard.service.js');

    if (!detectMinorDisclosurePatterns(turn.content).matched) return;

    const history = await getRecentSessionMessages(turn.sessionId, 10);
    const verdict = await confirmMinorDisclosure(turn.content, history, turn.sessionId);

    if (verdict.isMinor && verdict.confidence !== 'low') {
      const { sidebandManager } = await import('./sidebandManager.service.js');
      if (sidebandManager.getActiveConnections().includes(turn.sessionId)) {
        await sidebandManager.injectMessage(turn.sessionId, 'system', REALTIME_MINOR_GUIDANCE, false);
      }
      await handleConfirmedMinor({
        sessionId: turn.sessionId, messageId: turn.messageId ?? null, channel: 'realtime', statedAge: verdict.statedAge,
      });
    } else if (verdict.isMinor && verdict.confidence === 'low' && global.io) {
      void broadcastAdminEventForSession(global.io, 'session:eligibility-review', {
        sessionId: turn.sessionId, statedAge: verdict.statedAge, reasoning: verdict.reasoning, channel: 'realtime', at: new Date(),
      }, turn.sessionId);
    }
  } catch (err) {
    // Fail-open: an eligibility confirmation error must never end a session.
    console.error('[MinorSafeguard] realtime safeguard failed (fail-open):', err);
  }
}
