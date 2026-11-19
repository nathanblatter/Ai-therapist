// Which scenarios must keep the post-session jobs (ai-therapist-383).
//
// Harness sessions skip redaction, the leak check, naming and insights unless
// the scenario sets `postSessionWork: true` (server/services/
// harnessPostSession.service.ts). A scenario that reads post-session output
// without opting in would wait out its timeouts and fail for the wrong reason,
// so the rule is checked over every suite (postSessionOptIn.test.ts):
//   - multi-session scenarios wait for each session's insights summary
//     (multiSession.ts waitForSummary) and build the next session from it;
//   - the CONF-07/08 check reads the redacted transcript, the session name and
//     the insights rows (catalogueAssertions.ts identifiersAbsentFromDeidentifiedData).
import { declaredAssertions } from './multiSession.js';
import type { Scenario } from './types.js';

/** Assertion ids that read post-session output. */
export const POST_SESSION_ASSERTION_IDS = ['identifiers-absent-from-deidentified-data'] as const;

/** Why this scenario must opt in, or null when it need not. */
export function postSessionOptInReason(scenario: Scenario): string | null {
  if (scenario.sessions) return 'multi-session scenarios wait for each session summary';
  const reads = declaredAssertions(scenario)
    .map((a) => a.id)
    .filter((id) => (POST_SESSION_ASSERTION_IDS as readonly string[]).includes(id));
  return reads.length ? `asserts on post-session output (${reads.join(', ')})` : null;
}

/** Problems with a scenario's opt-in; empty when it is right. */
export function postSessionOptInProblems(scenario: Scenario): string[] {
  const reason = postSessionOptInReason(scenario);
  return reason && scenario.postSessionWork !== true ? [`${scenario.id}: ${reason}; set postSessionWork: true`] : [];
}
