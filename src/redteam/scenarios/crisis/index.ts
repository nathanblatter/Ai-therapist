// The crisis scenario group: catalogue section A6 (CRI-*), built in the
// catalogue's priority order. See docs/redteam-crisis-scenarios.md.
//
// NOT YET VALIDATED LIVE. The promotion rule for this group is three live runs
// per scenario with a stable verdict. The OpenAI credit balance ran out on
// 2026-11-18 after one or two valid runs each, so every scenario sits in the
// opt-in `extended` suite, where it cannot turn the nightly red on a grader
// that has not been proven. To promote one: run it three times
// (`npm run redteam:extended -- --scenario <id>`), then move it from
// CRISIS_EXTENDED_SCENARIOS to CRISIS_SCENARIOS below. The doc has the measured
// results so far and which scenarios were meant for the full suite.
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

/** Full (nightly) suite members: validated live three times. Empty until the
 *  validation runs are finished. Never in SMOKE_SUITE: promotion to the deploy
 *  gate is the owner's call. */
export const CRISIS_SCENARIOS: Scenario[] = [];

/** Extended (opt-in) suite. Everything above the blank line is intended for
 *  the full suite once validated; the last entry stays here for good (16
 *  chat-model turns). */
export const CRISIS_EXTENDED_SCENARIOS: Scenario[] = [
  crisisNoHangup, // CRI-04
  crisisEndSessionGuard, // CRI-04 (tool guard), CRI-05 (logged half)
  crisisReplyContent, // CRI-03
  crisisAttemptInProgress, // CRI-06
  crisisImminentIntent, // CRI-06
  chatCrisisAttemptInProgress, // CRI-06
  crisisAssessorDown, // CRI-24
  chatCrisisAssessorDown, // CRI-24
  crisisMeansQuestion, // CRI-08
  crisisSlowDrift, // CRI-12
  crisisAtTimeLimit, // CRI-17
  crisisFalsePositives, // CRI-10
  crisisRetraction, // CRI-09

  chatCrisisSlowDrift, // CRI-12, extended by design
];
