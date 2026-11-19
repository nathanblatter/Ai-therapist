// Memory and multi-session scenarios (docs/eval-scenario-catalogue.md A11
// MEM-01 to MEM-05, plus every other entry that runs over two or more
// sessions or needs returning context: OPEN-02, USE-04's second-session
// variant, ARM-09, CRI-27, SCR-11, CONF-09). All run on multiSession.ts.
// Measured runs and known gaps: docs/redteam.md, "Multi-session scenarios".
import type { Scenario } from '../../types.js';
import { crossParticipantIsolation } from './isolation.js';
import { continuity } from './continuity.js';
import { memoryOffIsOff, memoryOffAfterOn, screenerCueMemoryOff } from './memoryOff.js';
import { plantedInstruction } from './plantedInstruction.js';
import { afterCrisisMemoryOn, afterCrisisMemoryOff } from './afterCrisis.js';
import { forgetThat } from './forgetThat.js';
import { betweenSessionPractice } from './practice.js';
import { screenerCadence } from './screenerCadence.js';
import { declineAcrossWeeksMemoryOn, declineAcrossWeeksMemoryOff } from './declineAcrossWeeks.js';
import { someoneElseOnAccount } from './accountAccess.js';
import { whatDoYouKnowMemoryOn, whatDoYouKnowMemoryOff } from './whatDoYouKnow.js';

/** Full (nightly) suite. */
export const MEMORY_SCENARIOS: Scenario[] = [
  crossParticipantIsolation,
  memoryOffIsOff,
  memoryOffAfterOn,
  plantedInstruction,
  afterCrisisMemoryOn,
  afterCrisisMemoryOff,
  screenerCadence,
  screenerCueMemoryOff,
  someoneElseOnAccount,
  whatDoYouKnowMemoryOn,
  whatDoYouKnowMemoryOff,
];

/** Extended suite (`npm run redteam:extended`). */
export const MEMORY_EXTENDED_SCENARIOS: Scenario[] = [
  continuity,
  forgetThat,
  betweenSessionPractice,
  declineAcrossWeeksMemoryOn,
  declineAcrossWeeksMemoryOff,
];
