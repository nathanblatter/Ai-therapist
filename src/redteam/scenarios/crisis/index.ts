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
import { crisisFalsePositives, chatCrisisFalsePositives } from './falsePositives.js';
import { crisisRetraction } from './retraction.js';
import { chatPassiveIdeation } from './passiveIdeationChat.js';
import { chatCrisisAsksToStop } from './asksToStop.js';
import { crisisPromiseBeforeDisclosure } from './promiseBeforeDisclosure.js';
import { CRISIS_SLANG_SCENARIOS } from './slang.js';
import { crisisSelfHarmNoIntent } from './selfHarmNoIntent.js';
import { crisisHarmOthers, chatCrisisHarmOthers } from './harmToOthers.js';
import { crisisFirstMessage } from './firstMessage.js';
import { crisisMidExercise } from './midExercise.js';
import { crisisDisconnectAfterDisclosure } from './disconnect.js';
import { crisisRefusesHotline } from './refusesHotline.js';
import { crisisStructuredSafetyQuestions } from './safetyQuestions.js';
import { CRISIS_OTHER_LANGUAGE_SCENARIOS, chatCrisisOtherLanguage } from './otherLanguage.js';
import { crisisMessagesThread } from './messagesThread.js';
import { crisisAcrossQuietHours } from './quietHours.js';

/** Full (nightly) suite: each validated 3 of 3 live on 2026-11-18. Never in
 *  SMOKE_SUITE: promotion to the deploy gate is the owner's call. */
export const CRISIS_SCENARIOS: Scenario[] = [
  crisisNoHangup, // CRI-04
  crisisEndSessionGuard, // CRI-04 (tool guard), CRI-05 (logged half)
  crisisReplyContent, // CRI-03 (known gap ai-therapist-305)
  crisisAttemptInProgress, // CRI-06
  crisisImminentIntent, // CRI-06
  crisisAssessorDown, // CRI-24
  chatCrisisAssessorDown, // CRI-24
  crisisSlowDrift, // CRI-12
  crisisAtTimeLimit, // CRI-17
  crisisFalsePositives, // CRI-10
  crisisRetraction, // CRI-09
  // Second pass (catalogue NIGHTLY tier), each validated live on 2026-11-18
  // with the same gating verdict in 3 or more runs on its final graders.
  // Known gaps report on every run without gating (see each scenario).
  chatPassiveIdeation, // CRI-02 (chat)
  chatCrisisAsksToStop, // CRI-05 (reply half; unfiled gap: door left open)
  crisisPromiseBeforeDisclosure, // CRI-07 (known gap ai-therapist-301 removed 2026-11-21)
  chatCrisisFalsePositives, // CRI-10 (chat)
  ...CRISIS_SLANG_SCENARIOS, // CRI-11
  crisisSelfHarmNoIntent, // CRI-13 (unfiled gaps: run_risk_check, urge alternatives)
  crisisHarmOthers, // CRI-14 detection (unfiled gap: real disclosure scores 0)
  chatCrisisHarmOthers, // CRI-14 replies (unfiled gaps incl. a false page on the idiom; 301)
  crisisFirstMessage, // CRI-15
  crisisDisconnectAfterDisclosure, // CRI-18
  crisisRefusesHotline, // CRI-19 (unfiled gaps: alternatives, 988 a third time)
  crisisMessagesThread, // CRI-26
];

/** Extended (opt-in) suite, with the reason each is here. */
export const CRISIS_EXTENDED_SCENARIOS: Scenario[] = [
  // CRI-06. Two runs on its final known-gap list, one short of three. Its two
  // gap assertions (ai-therapist-300) each passed in some runs and failed in
  // others because the model's reply varied; after PR #39 (migration 125)
  // both passed 3 of 3 and the marker was removed on 2026-11-21. Still here:
  // promotion to `full` is a separate decision.
  chatCrisisAttemptInProgress,
  // CRI-08. Two runs on the final `no-means-information` grader, one short of
  // three (the grader was corrected after its first validation run). Promote
  // after one more run.
  crisisMeansQuestion,
  // CRI-12. Validated 3 of 3; here for good because it is 16 chat-model turns
  // (about 80 seconds and 200k input tokens a run).
  chatCrisisSlowDrift,
  // Catalogue EXT tier (weekly / before launch), each validated live on
  // 2026-11-18 with the same gating verdict in 3 or more runs.
  crisisMidExercise, // CRI-16 (unfiled gap: "killing myself" is not a keyword)
  crisisStructuredSafetyQuestions, // CRI-20 (unfiled gaps: several questions per turn, protective factors)
  ...CRISIS_OTHER_LANGUAGE_SCENARIOS, // CRI-21 detection (unfiled gap: code switch scores medium)
  chatCrisisOtherLanguage, // CRI-21 reply
  crisisAcrossQuietHours, // GATE-02
];
