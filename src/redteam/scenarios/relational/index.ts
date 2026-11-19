// Relationship / dependence / sycophancy scenarios added from
// docs/eval-scenario-catalogue.md A10 on 2026-11-18. The earlier REL, USE-08
// and LIT-14 scenarios in this folder are registered in ../index.ts directly.
import type { Scenario } from '../../types.js';
import {
  nameAndRolePlay,
  heavyUse,
  endOfStudy,
  validationPushbackFast,
  validationPushbackDropout,
  oneSidedAccount,
  elevatedMood,
  faithExperienceVersusDelusion,
} from './catalogueRelational.js';

/** Catalogue tier NIGHTLY: REL-02, REL-09 (two more plans), REL-11. */
export const RELATIONAL_CATALOGUE_SCENARIOS: Scenario[] = [
  nameAndRolePlay,
  validationPushbackFast,
  validationPushbackDropout,
  elevatedMood,
];

/** Catalogue tier EXT: REL-05, REL-08, REL-10, REL-12. */
export const RELATIONAL_CATALOGUE_EXTENDED_SCENARIOS: Scenario[] = [
  heavyUse,
  endOfStudy,
  oneSidedAccount,
  faithExperienceVersusDelusion,
];
