// Scenario registry + suite composition (spec §8; quality/voice: ai-therapist-124).
import type { Scenario } from '../types.js';
import type { RedteamSuite } from '../config.js';
import { crisisLadder } from './crisisLadder.js';
import { chatCrisisLadder } from './chatCrisisLadder.js';
import { diagnosisSeeking } from './diagnosisSeeking.js';
import { medication } from './medication.js';
import { promptInjection } from './promptInjection.js';
import { boundaryTesting } from './boundaryTesting.js';
import { minorAge } from './minorAge.js';
import { firstSession } from './quality/firstSession.js';
import { ramblingVenting } from './quality/ramblingVenting.js';
import { terseParticipant } from './quality/terseParticipant.js';
import { adviceSeeker } from './quality/adviceSeeker.js';
import { lowMoodSupport } from './quality/lowMoodSupport.js';
import { voiceCrisisLadder, voiceFirstSession } from './voice.js';

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
  diagnosisSeeking,
  medication,
  promptInjection,
  boundaryTesting,
  minorAge,
];

// Quality scenarios (ai-therapist-124): ordinary-participant personas gated on
// judge rubric floors, with only cheap hard assertions as a backstop.
export const QUALITY_SCENARIOS: Scenario[] = [
  firstSession,
  ramblingVenting,
  terseParticipant,
  adviceSeeker,
  lowMoodSupport,
];

export const ALL_SCENARIOS: Scenario[] = [...SAFETY_SCENARIOS, ...QUALITY_SCENARIOS];

// FULL: every scenario (safety + quality), all beats, judge as declared.
export const FULL_SUITE: SuiteEntry[] = ALL_SCENARIOS.map(scenario => ({ scenario }));

// QUALITY: rubric-floor scenarios only (nightly quality job).
export const QUALITY_SUITE: SuiteEntry[] = QUALITY_SCENARIOS.map(scenario => ({ scenario }));

// VOICE: real Realtime audio scenarios. Deliberately its own opt-in suite —
// each run is minutes of wall-clock and bills Realtime audio rates, so voice
// never rides along with full/smoke. NOT part of ALL_SCENARIOS: the voice
// variants reuse safety/quality scenario definitions with new ids.
export const VOICE_SCENARIOS: Scenario[] = [voiceFirstSession, voiceCrisisLadder];
export const VOICE_SUITE: SuiteEntry[] = VOICE_SCENARIOS.map(scenario => ({ scenario }));

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
    suite === 'smoke' ? SMOKE_SUITE :
    suite === 'quality' ? QUALITY_SUITE :
    suite === 'voice' ? VOICE_SUITE :
    FULL_SUITE;
  if (!scenarioId) return base;
  return base.filter(e => e.scenario.id === scenarioId);
}
