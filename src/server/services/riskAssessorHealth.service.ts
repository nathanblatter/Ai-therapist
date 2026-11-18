// Health of the stage-2 LLM risk assessor, and the staff-facing signal when it
// is down (ai-therapist-190).
//
// When an assessment fails, detection degrades to the keyword screen. That is
// the designed fallback and it holds, but until this module existed the only
// trace was `method: 'keyword_fallback'` inside risk_score_history.score_factors:
// an audit trail, not a signal. Staff watching a session had no way to know its
// turns were being scored without the assessor, and an outage that was not a
// billing cap (a mistyped crisis.risk_model, an expired key, an OpenAI
// incident) reached nobody.
//
// Two signals, both deduplicated:
//
//   per session   The first failed assessment in a session writes ONE
//                 intervention_actions row and emits ONE
//                 `session:risk-assessment-degraded` event, so the session
//                 record says its scoring was degraded. Which individual turns
//                 were affected is on each risk_score_history row
//                 (`assessment_degraded`, `llm_error`).
//   per incident  SUSTAINED_FAILURES failed assessments in a row, with no
//                 success between them, is an incident: one error log, one
//                 `system:risk-assessment-degraded` event to the researcher
//                 room and one page to the on-call (crisisAlert throttles it).
//                 The next success closes the incident.
//
// A "failed assessment" has already exhausted its own retry budget
// (utils/openaiErrors), so two in a row is not a blip. Billing-cap rejections
// count toward the incident but are paged by reportOpenAIQuotaExhausted, which
// carries the instruction that fixes them; they are not paged twice.
//
// State is in-process, like the quota throttle: a restart forgets an open
// incident and the next two failures report it again, which is the safe
// direction. Nothing here throws, and nothing here is awaited on a path that
// produces a participant's score except the one small per-session insert.
import { createLogger } from '../utils/logger.js';
import type { OpenAIErrorInfo } from '../utils/openaiErrors.js';

const log = createLogger('riskAssessorHealth');

/** Failed assessments in a row that make an incident. */
export const SUSTAINED_FAILURES = 2;

/** intervention_actions.action_type has a CHECK constraint (migration 118); a
 *  degraded-assessor row rides the existing 'external_api_called' type with a
 *  detail payload, the same way a sandbox paging suppression does, so no
 *  migration is needed. */
const DEGRADED_ACTION_TYPE = 'external_api_called';

let consecutiveFailures = 0;
let firstFailureAt: number | null = null;
let incidentReported = false;
let incidentPaged = false;
// Sessions already marked during the current run of failures.
const markedSessions = new Set<string>();
const MARKED_SESSIONS_MAX = 2000;

/** True while the assessor is known to be down (an incident is open). Callers
 *  use it to stop spending patient retries on a call that keeps failing. */
export function assessorIncidentOpen(): boolean {
  return consecutiveFailures >= SUSTAINED_FAILURES;
}

/** Test hook: forget all state. */
export function _resetAssessorHealthForTests(): void {
  consecutiveFailures = 0;
  firstFailureAt = null;
  incidentReported = false;
  incidentPaged = false;
  markedSessions.clear();
}

/** An assessment succeeded: any open incident is over. Never throws. */
export function noteAssessorSuccess(): void {
  try {
    if (consecutiveFailures === 0) return;
    const wasIncident = assessorIncidentOpen();
    const failures = consecutiveFailures;
    const since = firstFailureAt;
    consecutiveFailures = 0;
    firstFailureAt = null;
    incidentReported = false;
    incidentPaged = false;
    markedSessions.clear();
    if (!wasIncident) return;
    log.warn(
      { failures, downForMs: since ? Date.now() - since : null },
      '[risk] assessor restored: risk assessment is no longer degraded',
    );
    if (global.io) {
      global.io.to('admin-broadcast').emit('system:risk-assessment-restored', { failures, restoredAt: new Date() });
    }
  } catch (err) {
    log.error({ err }, '[risk] failed to record assessor recovery');
  }
}

/**
 * An assessment failed after its retries. Marks the session once, and reports
 * the incident once when the failures are sustained. Never throws.
 */
export async function noteAssessorFailure(sessionId: string | null, info: OpenAIErrorInfo): Promise<void> {
  try {
    consecutiveFailures += 1;
    firstFailureAt ??= Date.now();

    if (sessionId && !markedSessions.has(sessionId)) {
      if (markedSessions.size >= MARKED_SESSIONS_MAX) {
        for (const id of markedSessions) {
          if (markedSessions.size <= MARKED_SESSIONS_MAX / 2) break;
          markedSessions.delete(id);
        }
      }
      markedSessions.add(sessionId);
      await markSessionDegraded(sessionId, info);
    }

    if (assessorIncidentOpen()) {
      if (!incidentReported) {
        incidentReported = true;
        reportIncident(info);
      }
      pageIncident(info);
    }
  } catch (err) {
    log.error({ err }, '[risk] failed to record an assessor failure');
  }
}

async function markSessionDegraded(sessionId: string, info: OpenAIErrorInfo): Promise<void> {
  try {
    const { logInterventionAction } = await import('./crisisDetection.service.js');
    await logInterventionAction(sessionId, DEGRADED_ACTION_TYPE, {
      degraded: 'risk_assessor',
      reason: info.kind,
      code: info.code,
      status: info.status,
      detail:
        'Risk assessment degraded: the AI risk assessor was unavailable, so turns in this session are scored by ' +
        'the keyword screen only until it recovers. Affected turns carry assessment_degraded in risk_score_history.',
    });
    if (global.io) {
      const { broadcastAdminEventForSession } = await import('../utils/adminBroadcast.js');
      void broadcastAdminEventForSession(
        global.io,
        'session:risk-assessment-degraded',
        {
          sessionId,
          component: 'risk_assessor',
          reason: info.kind,
          message: 'Risk assessment degraded: assessor unavailable, keyword screen only',
          at: new Date(),
        },
        sessionId,
        'summary',
      );
    }
  } catch (err) {
    log.error({ err }, `[risk] failed to mark session ${sessionId} as assessed in degraded mode`);
  }
}

function reportIncident(info: OpenAIErrorInfo): void {
  log.error(
    { kind: info.kind, code: info.code, status: info.status, failures: consecutiveFailures },
    '[risk] SUSTAINED ASSESSOR OUTAGE: crisis detection is degraded to the keyword screen',
  );
  try {
    if (global.io) {
      global.io.to('admin-broadcast').emit('system:risk-assessment-degraded', {
        component: 'risk_assessor',
        reason: info.kind,
        code: info.code,
        failures: consecutiveFailures,
        since: firstFailureAt ? new Date(firstFailureAt) : new Date(),
        message: 'Risk assessment degraded: the AI risk assessor is failing, crisis detection is keyword-only',
      });
    }
  } catch (err) {
    log.error({ err }, '[risk] failed to broadcast the assessor outage');
  }
}

/**
 * Page the on-call about the open incident, once. Called on every failure
 * while the incident is open so that a page that could not be delivered (a
 * pager blip, or the hourly throttle from a previous incident) is tried again
 * rather than lost; `incidentPaged` and crisisAlert's own claim-before-send
 * throttle keep that to a single delivered page.
 */
function pageIncident(info: OpenAIErrorInfo): void {
  // The billing cap has its own page (reportOpenAIQuotaExhausted), sent on the
  // first rejection and repeated hourly; do not page the same cause twice.
  if (incidentPaged || info.kind === 'quota') return;
  incidentPaged = true;
  const failures = consecutiveFailures;
  void import('./crisisAlert.service.js')
    .then((m) => m.reportRiskAssessorOutage(info.kind, info.code, failures))
    .then((delivered) => {
      if (!delivered) incidentPaged = false;
    })
    .catch((err) => {
      incidentPaged = false;
      log.error({ err }, '[risk] failed to page the assessor outage');
    });
}
