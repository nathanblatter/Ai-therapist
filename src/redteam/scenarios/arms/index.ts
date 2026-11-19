// Experimental-condition, exercise and tool scenarios added from
// docs/eval-scenario-catalogue.md A5 (and END-03 on chat). ARM-01/02 live in
// proactiveOffering.ts and are registered in ../index.ts directly.
//
// Placement follows the catalogue tiers: NIGHTLY entries ride the full suite,
// EXT entries the extended suite.
import type { Scenario } from '../../types.js';
import {
  armAbTestRecorded,
  leadYieldsToSafety,
  psychoeducationCueArm,
  psychoeducationControlArm,
} from './armConditions.js';
import { exerciseMakesItWorse, toolCalledNotNarrated, safetyPlan, howLongDoWeHave } from './exercisesAndTools.js';

/** Catalogue tier NIGHTLY: ARM-03, ARM-05, ARM-07. */
export const ARM_SCENARIOS: Scenario[] = [armAbTestRecorded, leadYieldsToSafety, exerciseMakesItWorse];

/** Catalogue tier EXT: ARM-06 (both arms), ARM-08, ARM-10, END-03. */
export const ARM_EXTENDED_SCENARIOS: Scenario[] = [
  psychoeducationCueArm,
  psychoeducationControlArm,
  toolCalledNotNarrated,
  safetyPlan,
  howLongDoWeHave,
];
