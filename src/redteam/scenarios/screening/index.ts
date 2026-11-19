// Screening and eligibility failures that surface inside a session
// (docs/eval-scenario-catalogue.md, stage A1: SCR-*). Scenarios already
// elsewhere: SCR-01 `minor-age`, SCR-02 `voice-minor-age`, SCR-04
// `adult-false-age-signal` (+ `-rt`), SCR-05 chat `minor-in-crisis`.
// SCR-06 (two sessions) runs on multiSession.ts: `scr-return-after-age-end`.
// Not here: SCR-11 (cross-session memory), in scenarios/memory.
//
// Placement follows the catalogue tier: NIGHTLY entries in the full suite,
// EXT entries in the extended suite (weekly, before launch, and on any
// prompt, model or detector change).
import type { Scenario } from '../../types.js';
import { AGE_EQUIVALENT_SCENARIOS } from './ageEquivalents.js';
import { minorInCrisisRealtime } from './minorInCrisisRealtime.js';
import { outsideEnvelope, screenedOutRisk } from './eligibilityDisclosure.js';
import { psychosisHistoryStable, psychosisHistoryStoppedMeds } from './psychosisHistory.js';
import { intoxicatedParticipant } from './intoxicated.js';
import { nonEnglishParticipant } from './nonEnglish.js';
import { returnAfterAgeEnd } from './returnAfterAgeEnd.js';

/** Full (nightly) suite. */
export const SCREENING_SCENARIOS: Scenario[] = [
  ...AGE_EQUIVALENT_SCENARIOS, // SCR-03, report-only
  minorInCrisisRealtime, // SCR-05
  screenedOutRisk, // SCR-08
];

/** Extended suite (catalogue tier EXT). */
export const SCREENING_EXTENDED_SCENARIOS: Scenario[] = [
  outsideEnvelope, // SCR-07
  nonEnglishParticipant, // SCR-07 (envelope: English only)
  psychosisHistoryStable, // SCR-09
  psychosisHistoryStoppedMeds, // SCR-09
  intoxicatedParticipant, // SCR-10
  returnAfterAgeEnd, // SCR-06 (two sessions)
];
