// Protocol scenarios: honesty, reporting, abuse, eligibility and withdrawal
// (docs/eval-scenario-catalogue.md, stages A1 and A7 to A9). In the full
// (nightly) suite since 2026-11-18, after three live runs each with the same
// grading every time. Promotion of any of them to the smoke deploy gate is the
// owner's call.
//
// The two minors hard-refusal scenarios (ABU-06) are the exception: ON DEMAND
// ONLY, in the `extended` suite, never the nightly and never a deploy gate.
// OpenAI's moderation model flagged the product's own replies to these probes
// as `sexual/minors` in 4 of 4 runs (the model declines, then offers
// alternative versions: ai-therapist-302). Running them nightly would generate
// that flagged traffic on the study's OpenAI organisation five times a night.
// The reserved harness identifier keeps enforcement away from participants'
// identifiers, but enforcement can also act on the organisation or project,
// which would take the study's AI down. Promote them to PROTOCOL_SCENARIOS
// only after the prompt fix for ai-therapist-302 has landed AND three
// consecutive on-demand runs have produced no reply flagged by moderation
// (`reply-not-sexual` passing in `minor-sexual-content-referral`).
import type { Scenario } from '../../types.js';
import { honestyConfidentiality, honestyDisclosure } from './honestyConfidentiality.js';
import { minorSexualContent, minorSexualContentReferral } from './minorSexualContent.js';
import { adultFalseAgeSignal, adultFalseAgeSignalRealtime } from './adultFalseAgeSignal.js';
import { minorInCrisis } from './minorInCrisis.js';
import { studyWithdrawal, withdrawalFeelingWorse, withdrawalProcedure } from './studyWithdrawal.js';
import { partnerViolenceDisclosure, childAbuseDisclosure, abuseRetraction } from './abuseDisclosure.js';
import { talkToARealPerson, noFalseActions } from './actionClaims.js';

export const PROTOCOL_SCENARIOS: Scenario[] = [
  honestyConfidentiality,
  honestyDisclosure,
  adultFalseAgeSignal,
  adultFalseAgeSignalRealtime,
  minorInCrisis,
  studyWithdrawal,
  partnerViolenceDisclosure,
  childAbuseDisclosure,
  abuseRetraction,
  talkToARealPerson,
  noFalseActions,
  withdrawalFeelingWorse,
  withdrawalProcedure,
];

/** On demand only (`npm run redteam:extended -- --scenario <id>`): see the header. */
export const PROTOCOL_EXTENDED_SCENARIOS: Scenario[] = [minorSexualContent, minorSexualContentReferral];
