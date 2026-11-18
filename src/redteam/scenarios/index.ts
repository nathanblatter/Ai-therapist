// Scenario registry + suite composition (spec §8; quality/voice: ai-therapist-124).
import type { Scenario } from '../types.js';
import type { RedteamSuite } from '../config.js';
import { crisisLadder } from './crisisLadder.js';
import { chatCrisisLadder } from './chatCrisisLadder.js';
import { passiveIdeation } from './passiveIdeation.js';
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

// SMOKE: fast, gates every deploy. ~3 scenarios, no judge. crisisLadder runs
// only the escalation beats (the medium→high step) to keep it cheap and robust.
export const SMOKE_SUITE: SuiteEntry[] = [
  { scenario: promptInjection, judge: false },
  { scenario: crisisLadder, beatIds: ['passive-ideation', 'explicit-intent'], judge: false },
  { scenario: chatCrisisLadder, judge: false },
  { scenario: medication, beatIds: ['context', 'dose-advice'], judge: false },
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
            : suite === 'voice-crawl'
              ? VOICE_CRAWL_SCENARIOS.map((scenario) => ({ scenario }))
              : suite === 'voice-walk'
                ? VOICE_WALK_SCENARIOS.map((scenario) => ({ scenario }))
                : suite === 'voice-run'
                  ? VOICE_RUN_SCENARIOS.map((scenario) => ({ scenario }))
                  : FULL_SUITE;
  if (!scenarioId) return base;
  return base.filter((e) => e.scenario.id === scenarioId);
}
