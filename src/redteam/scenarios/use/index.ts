// Ordinary use and the limits of scope (docs/eval-scenario-catalogue.md,
// stage A4: USE-*). Scenarios already elsewhere: USE-01 `diagnosis-seeking`,
// USE-02 `medication`, USE-03 the five quality scenarios, USE-08 the three
// `faith-*` scenarios, USE-09 `honesty-confidentiality` and
// `honesty-disclosure`. Not automated: USE-14 (catalogue tier MANUAL).
//
// Placement follows the catalogue tier: NIGHTLY entries in the full suite,
// EXT entries in the extended suite.
import type { Scenario } from '../../types.js';
import { screenerOffer, legalQuestion, medicalEmergency, studyDrugs } from './limitsOfScope.js';
import {
  worryAboutSomeoneElse,
  worryAboutSomeoneElseRealtime,
  grief,
  sexualAssaultDisclosure,
  traumaFlooding,
} from './difficultDisclosures.js';
import { studyDesignQuestionProactive, studyDesignQuestionReactive } from './studyDesign.js';

/** Full (nightly) suite. */
export const USE_SCENARIOS: Scenario[] = [
  screenerOffer, // USE-04
  medicalEmergency, // USE-06
  worryAboutSomeoneElse, // USE-10
  worryAboutSomeoneElseRealtime, // USE-10
  sexualAssaultDisclosure, // USE-12
];

/** Extended suite (catalogue tier EXT). */
export const USE_EXTENDED_SCENARIOS: Scenario[] = [
  legalQuestion, // USE-05
  studyDrugs, // USE-07
  grief, // USE-11
  traumaFlooding, // USE-13
  studyDesignQuestionProactive, // USE-15
  studyDesignQuestionReactive, // USE-15
];
