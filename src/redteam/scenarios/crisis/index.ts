// The crisis scenario group: catalogue section A6 (CRI-*), built in the
// catalogue's priority order. Measured results, known gaps and the promotion
// rule are in docs/redteam-crisis-scenarios.md.
//
// Promotion rule: three live runs with the same verdict, on the graders as
// they stand, before a scenario joins the full (nightly) suite. A scenario
// with a known product gap qualifies when its grading is stable; the gap
// itself reports on every run without gating (knownGap.ts).
import type { Scenario } from '../../types.js';
import { crisisNoHangup, crisisEndSessionGuard } from './noHangup.js';
import { crisisReplyContent } from './replyContent.js';
import { crisisAttemptInProgress, crisisImminentIntent, chatCrisisAttemptInProgress } from './attemptInProgress.js';
import { crisisAssessorDown, chatCrisisAssessorDown } from './assessorDown.js';
import { crisisMeansQuestion } from './meansQuestion.js';
import { crisisSlowDrift, chatCrisisSlowDrift } from './slowDrift.js';
import { crisisAtTimeLimit } from './timeLimit.js';
import { crisisFalsePositives } from './falsePositives.js';
import { crisisRetraction } from './retraction.js';

/** Full (nightly) suite: each validated 3 of 3 live on 2026-11-18. Never in
 *  SMOKE_SUITE: promotion to the deploy gate is the owner's call. */
export const CRISIS_SCENARIOS: Scenario[] = [
  crisisNoHangup, // CRI-04
  crisisEndSessionGuard, // CRI-04 (tool guard), CRI-05 (logged half)
  crisisReplyContent, // CRI-03 (known gap ai-therapist-305)
  crisisAttemptInProgress, // CRI-06
  crisisImminentIntent, // CRI-06 (known gap ai-therapist-299)
  crisisAssessorDown, // CRI-24 (known gap ai-therapist-190)
  chatCrisisAssessorDown, // CRI-24
  crisisSlowDrift, // CRI-12
  crisisAtTimeLimit, // CRI-17
  crisisFalsePositives, // CRI-10
  crisisRetraction, // CRI-09
];

/** Extended (opt-in) suite, with the reason each is here. */
export const CRISIS_EXTENDED_SCENARIOS: Scenario[] = [
  // CRI-06. Two runs on its final known-gap list, one short of three. Its two
  // gap assertions (ai-therapist-300) each pass in some runs and fail in
  // others because the model's reply varies; promote after one more run.
  chatCrisisAttemptInProgress,
  // CRI-08. Two runs on the final `no-means-information` grader, one short of
  // three (the grader was corrected after its first validation run). Promote
  // after one more run.
  crisisMeansQuestion,
  // CRI-12. Validated 3 of 3; here for good because it is 16 chat-model turns
  // (about 80 seconds and 200k input tokens a run).
  chatCrisisSlowDrift,
];
