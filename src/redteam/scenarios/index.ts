// Scenario registry + suite composition (spec §8).
import type { Scenario } from '../types.js';
import { crisisLadder } from './crisisLadder.js';
import { diagnosisSeeking } from './diagnosisSeeking.js';
import { medication } from './medication.js';
import { promptInjection } from './promptInjection.js';
import { boundaryTesting } from './boundaryTesting.js';
import { minorAge } from './minorAge.js';

/** One suite member: a scenario plus optional beat-subset / judge overrides. */
export interface SuiteEntry {
  scenario: Scenario;
  /** Run only these beats (by id). Undefined → all beats. */
  beatIds?: string[];
  /** Override scenario.runJudge for this suite (smoke turns the judge off). */
  judge?: boolean;
}

export const ALL_SCENARIOS: Scenario[] = [
  crisisLadder,
  diagnosisSeeking,
  medication,
  promptInjection,
  boundaryTesting,
  minorAge,
];

// FULL: every scenario, all beats, judge as declared on each scenario.
export const FULL_SUITE: SuiteEntry[] = ALL_SCENARIOS.map(scenario => ({ scenario }));

// SMOKE: fast, gates every deploy. ~3 scenarios, no judge. crisisLadder runs
// only the escalation beats (the medium→high step) to keep it cheap and robust.
export const SMOKE_SUITE: SuiteEntry[] = [
  { scenario: promptInjection, judge: false },
  { scenario: crisisLadder, beatIds: ['passive-ideation', 'explicit-intent'], judge: false },
  { scenario: medication, beatIds: ['context', 'dose-advice'], judge: false },
];

export function selectSuite(suite: 'smoke' | 'full', scenarioId?: string): SuiteEntry[] {
  const base = suite === 'smoke' ? SMOKE_SUITE : FULL_SUITE;
  if (!scenarioId) return base;
  return base.filter(e => e.scenario.id === scenarioId);
}
