// Scenario registry + suite composition (spec §8; quality/voice: ai-therapist-124).
import type { Scenario } from '../types.js';
import type { RedteamSuite } from '../config.js';
import { crisisLadder } from './crisisLadder.js';
import { chatCrisisLadder } from './chatCrisisLadder.js';
import { passiveIdeation } from './passiveIdeation.js';
import { CRISIS_SCENARIOS, CRISIS_EXTENDED_SCENARIOS } from './crisis/index.js';
import { diagnosisSeeking } from './diagnosisSeeking.js';
import { medication } from './medication.js';
import { promptInjection } from './promptInjection.js';
import { boundaryTesting } from './boundaryTesting.js';
import { minorAge } from './minorAge.js';
import { eatingDisorder } from './eatingDisorder.js';
import { substanceUse } from './substanceUse.js';
import { delusionalContent } from './delusionalContent.js';
import { assistantPromptInjection } from './assistantPromptInjection.js';
import { assistantRoleEscalation } from './assistantRoleEscalation.js';
import { assistantDataExfiltration } from './assistantDataExfiltration.js';
import { firstSession } from './quality/firstSession.js';
import { ramblingVenting } from './quality/ramblingVenting.js';
import { terseParticipant } from './quality/terseParticipant.js';
import { adviceSeeker } from './quality/adviceSeeker.js';
import { lowMoodSupport } from './quality/lowMoodSupport.js';
import { stallingParticipant } from './quality/stallingParticipant.js';
import { returningParticipant } from './quality/returningParticipant.js';
import { voiceCrisisLadder, voiceFirstSession, VOICE_SAFETY_SCENARIOS } from './voice.js';
import { VOICE_CRAWL_SCENARIOS, VOICE_WALK_SCENARIOS, VOICE_RUN_SCENARIOS } from '../voice/scenarios.js';
import { VOICE_OPENING_SCENARIOS } from '../voice/openingOnly.js';
import {
  PROTOCOL_SCENARIOS,
  PROTOCOL_EXTENDED_SCENARIOS,
  PROTOCOL_CATALOGUE_EXTENDED_SCENARIOS,
} from './protocol/index.js';
import { ARM_SCENARIOS, ARM_EXTENDED_SCENARIOS } from './arms/index.js';
import { RELATIONAL_CATALOGUE_SCENARIOS, RELATIONAL_CATALOGUE_EXTENDED_SCENARIOS } from './relational/index.js';
import { STAFF_SCENARIOS, STAFF_EXTENDED_SCENARIOS } from './staff/index.js';
import { validationPushbackMedication, validationPushbackEx } from './relational/validationPushback.js';
import { companionAvailability, exclusiveReliance, goodbye } from './relational/companionDependence.js';
import { faithMissionDoubt, faithBelonging, faithScrupulosity } from './relational/faith.js';
import { longSessionDrift } from './relational/longSessionDrift.js';
import { armProactiveOffering, armReactiveOffering } from './arms/proactiveOffering.js';
import { MEMORY_SCENARIOS, MEMORY_EXTENDED_SCENARIOS } from './memory/index.js';
import { SCREENING_SCENARIOS, SCREENING_EXTENDED_SCENARIOS } from './screening/index.js';
import { OPENING_SCENARIOS, OPENING_EXTENDED_SCENARIOS } from './opening/index.js';
import { USE_SCENARIOS, USE_EXTENDED_SCENARIOS } from './use/index.js';
import { GATE_SCENARIOS } from './gates/index.js';

/** One suite member: a scenario plus optional beat-subset / judge overrides. */
export interface SuiteEntry {
  scenario: Scenario;
  /** Run only these beats (by id). Undefined → all beats. */
  beatIds?: string[];
  /** Override scenario.runJudge for this suite (smoke turns the judge off). */
  judge?: boolean;
}

export const SAFETY_SCENARIOS: Scenario[] = [
  crisisLadder,
  chatCrisisLadder,
  passiveIdeation,
  // Catalogue A6 (CRI-*) scenarios validated 3 of 3 live; the rest of the
  // group waits in EXTENDED_SUITE. Never in SMOKE_SUITE.
  ...CRISIS_SCENARIOS,
  diagnosisSeeking,
  medication,
  promptInjection,
  boundaryTesting,
  minorAge,
  // ai-therapist-250: ED / substance / delusional families. Full suite only —
  // never in SMOKE_SUITE (the deploy gate must stay fast).
  eatingDisorder,
  substanceUse,
  delusionalContent,
  // ai-therapist-207: the ADMIN assistant surface (staff personas, seeded
  // adversarial data). Full suite only — needs the assistant fixtures and a
  // live model; never in SMOKE_SUITE.
  assistantPromptInjection,
  assistantRoleEscalation,
  assistantDataExfiltration,
  // docs/eval-scenario-catalogue.md A1, A7 to A9: honesty, reporting, abuse,
  // eligibility leaks and withdrawal. Full suite only; two carry a declared
  // known gap (listed assertions reported loudly, not gating). The minors
  // hard-refusal pair is NOT here: on demand only, in EXTENDED_SCENARIOS.
  ...PROTOCOL_SCENARIOS,
  // Catalogue REL-*/LIT-14, USE-08 and ARM-01/02 (docs/eval-scenario-catalogue.md),
  // each validated live on 2026-11-18 (3+ runs, grading stable across
  // classifier seeds). Full suite only. Known gaps (only the listed
  // assertions stop gating): ARM-01/02 ai-therapist-297, pushback-ex
  // ai-therapist-298, goodbye ai-therapist-311. USE-08 transcripts need a
  // human sample review.
  validationPushbackMedication,
  validationPushbackEx,
  companionAvailability,
  exclusiveReliance,
  goodbye,
  faithMissionDoubt,
  faithBelonging,
  faithScrupulosity,
  armProactiveOffering,
  armReactiveOffering,
  // Catalogue NIGHTLY-tier ARM, REL and STAFF scenarios added 2026-11-18
  // (arms/index.ts, relational/index.ts, staff/index.ts; the CONF/ABU/WDR
  // ones ride PROTOCOL_SCENARIOS). Calibration and known gaps: docs/redteam.md
  // "Catalogue coverage: ARM, END, WDR, CONF, ABU, REL, STAFF".
  ...ARM_SCENARIOS,
  ...RELATIONAL_CATALOGUE_SCENARIOS,
  ...STAFF_SCENARIOS,
  // Catalogue A11 (MEM-*) and the other multi-session entries: memory/index.ts.
  ...MEMORY_SCENARIOS,
  // Catalogue SCR-*, OPEN-*, USE-* entries the catalogue tiers NIGHTLY (the
  // EXT ones are in EXTENDED_SCENARIOS). Full suite only, never smoke. Known
  // gaps are listed per scenario (only the listed assertions stop gating).
  ...SCREENING_SCENARIOS,
  ...OPENING_SCENARIOS,
  ...USE_SCENARIOS,
  // Catalogue GATE-01, GATE-03 to GATE-06 and STAFF-10: http pipeline, no model, no judge.
  ...GATE_SCENARIOS,
];

// Quality scenarios (ai-therapist-124): ordinary-participant personas gated on
// judge rubric floors, with only cheap hard assertions as a backstop.
export const QUALITY_SCENARIOS: Scenario[] = [
  firstSession,
  ramblingVenting,
  terseParticipant,
  adviceSeeker,
  lowMoodSupport,
  // Session progression (owner feedback 2026-11-16): reported, not gated
  // beyond the low empathy floor. Never in SMOKE_SUITE.
  stallingParticipant,
  returningParticipant,
];

export const ALL_SCENARIOS: Scenario[] = [...SAFETY_SCENARIOS, ...QUALITY_SCENARIOS];

// FULL: every scenario (safety + quality), all beats, judge as declared.
export const FULL_SUITE: SuiteEntry[] = ALL_SCENARIOS.map((scenario) => ({ scenario }));

// QUALITY: rubric-floor scenarios only (nightly quality job).
export const QUALITY_SUITE: SuiteEntry[] = QUALITY_SCENARIOS.map((scenario) => ({ scenario }));

// VOICE: real voice-session scenarios on the backend system_config.ai_model
// selects. Deliberately its own opt-in suite: each run is minutes of
// wall-clock and bills per voice minute, so voice never rides along with
// full/smoke. NOT part of ALL_SCENARIOS: the voice variants reuse the
// safety/quality scenario definitions by reference under new ids. Kept at two
// scenarios: it is the default suite of the in-app nightly runner
// (harnessRunner.service.ts, 30-minute hard kill), so growing it would grow
// that schedule's cost and wall clock without anyone deciding to.
export const VOICE_SCENARIOS: Scenario[] = [voiceFirstSession, voiceCrisisLadder];
export const VOICE_SUITE: SuiteEntry[] = VOICE_SCENARIOS.map((scenario) => ({ scenario }));

// VOICE-SAFETY: the safety-critical families over a real voice session, with
// the GPT-Live two-layer checks (liveVoiceChecks.ts). Scheduled on its own by
// .github/workflows/redteam-voice.yml, which requires ai_model = gpt-live-*.
export const VOICE_SAFETY_SUITE: SuiteEntry[] = VOICE_SAFETY_SCENARIOS.map((scenario) => ({ scenario }));
// EXTENDED: scenarios too slow or expensive for the nightly (long chat
// conversations). Opt-in like voice, and NOT part of ALL_SCENARIOS: run it
// weekly, before launch, and on any prompt, model or detector change.
// It also holds the two minors hard-refusal scenarios (ABU-06), which must
// run only when someone deliberately runs them: see protocol/index.ts and
// docs/redteam.md for why and for the condition to promote them.
// rel-long-session-drift (14 model turns) has NOT been validated live yet:
// `npm run redteam:extended -- --scenario rel-long-session-drift --variations 3`.
export const EXTENDED_SCENARIOS: Scenario[] = [
  ...CRISIS_EXTENDED_SCENARIOS,
  ...PROTOCOL_EXTENDED_SCENARIOS,
  longSessionDrift,
  // Catalogue EXT-tier scenarios added 2026-11-18 (see SAFETY_SCENARIOS).
  ...ARM_EXTENDED_SCENARIOS,
  ...PROTOCOL_CATALOGUE_EXTENDED_SCENARIOS,
  ...RELATIONAL_CATALOGUE_EXTENDED_SCENARIOS,
  ...STAFF_EXTENDED_SCENARIOS,
  ...MEMORY_EXTENDED_SCENARIOS,
  ...SCREENING_EXTENDED_SCENARIOS,
  ...OPENING_EXTENDED_SCENARIOS,
  ...USE_EXTENDED_SCENARIOS,
];
export const EXTENDED_SUITE: SuiteEntry[] = EXTENDED_SCENARIOS.map((scenario) => ({ scenario }));

// SMOKE: fast, gates every deploy. ~3 scenarios, no judge. crisisLadder runs
// only the escalation beats (the medium→high step) to keep it cheap and robust.
export const SMOKE_SUITE: SuiteEntry[] = [
  { scenario: promptInjection, judge: false },
  { scenario: crisisLadder, beatIds: ['passive-ideation', 'explicit-intent'], judge: false },
  { scenario: chatCrisisLadder, judge: false },
  { scenario: medication, beatIds: ['context', 'dose-advice'], judge: false },
];

// Safety-critical scenarios for the sampled nightly (src/redteam/sampling.ts):
// the smoke four plus the crisis family. They get the weekly repeat slots
// first, so they run several times a week. Explicit list: new crisis scenarios
// join through CRISIS_SCENARIOS.
export const SAMPLING_PRIORITY_SCENARIOS: Scenario[] = [
  ...SMOKE_SUITE.map((e) => e.scenario),
  crisisLadder,
  chatCrisisLadder,
  passiveIdeation,
  ...CRISIS_SCENARIOS,
];

export function selectSuite(suite: RedteamSuite, scenarioId?: string): SuiteEntry[] {
  const base =
    suite === 'smoke'
      ? SMOKE_SUITE
      : suite === 'quality'
        ? QUALITY_SUITE
        : suite === 'voice'
          ? VOICE_SUITE
          : suite === 'voice-safety'
            ? VOICE_SAFETY_SUITE
            : suite === 'extended'
              ? EXTENDED_SUITE
              : suite === 'voice-crawl'
                ? VOICE_CRAWL_SCENARIOS.map((scenario) => ({ scenario }))
                : suite === 'voice-walk'
                  ? VOICE_WALK_SCENARIOS.map((scenario) => ({ scenario }))
                  : suite === 'voice-run'
                    ? VOICE_RUN_SCENARIOS.map((scenario) => ({ scenario }))
                    : suite === 'voice-opening'
                      ? VOICE_OPENING_SCENARIOS.map((scenario) => ({ scenario }))
                      : FULL_SUITE;
  if (!scenarioId) return base;
  // A comma-separated list runs several scenarios in one process (one server
  // boot, one cost summary), e.g. `--scenario grief,legal-question`.
  const ids = new Set(scenarioId.split(',').map((s) => s.trim()));
  return base.filter((e) => ids.has(e.scenario.id));
}
