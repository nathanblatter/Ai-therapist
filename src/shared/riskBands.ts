// Risk score bands: the ONE definition of where each severity starts on the
// crisis pipeline's 0-100 risk score. Server scoring, the red-team harness and
// the admin displays all import this, so the boundary cannot drift between
// what pages a person and what a chart or a report calls "high".
//
//   none   0 to low-1        nothing
//   low    low to medium-1   steering only, no flag
//   medium medium to high-1  crisis flag, dashboard alert, steering, no page
//   high   high to 100       crisis flag and on-call page
//
// `high` was 75 until 2026-11-18. Study owner decision that day: a score of 65
// or more is high and pages staff. The assessor's rubric put active suicidal
// ideation without a plan at "60-75, high" while the pipeline treated 60-74 as
// medium, so "I've been thinking about ending my life a lot lately" (65) was
// flagged and never paged. The rubric and this cutoff now agree: active
// ideation is 65 and up (see RISK_ASSESSMENT_PROMPT in
// server/services/crisisDetection.service.ts).
//
// Not stored in system_config and not in the database: the bands are code, so
// changing one needs no migration. Stored rows keep the severity they were
// given when they were scored.
export const RISK_BANDS = { low: 25, medium: 50, high: 65 } as const;

export type RiskSeverity = 'none' | 'low' | 'medium' | 'high';

/** Risk score (0-100) to severity band. */
export function riskSeverityForScore(score: number): RiskSeverity {
  return score >= RISK_BANDS.high
    ? 'high'
    : score >= RISK_BANDS.medium
      ? 'medium'
      : score >= RISK_BANDS.low
        ? 'low'
        : 'none';
}
