// Scenarios that never run on a schedule, only when someone runs them
// deliberately (`npm run redteam:extended -- --scenario <id>`).
//
// The scheduled weekly run of the extended suite
// (.github/workflows/redteam-extended.yml) passes `--skip-on-demand`, which
// drops these ids and nothing else. Everything else in `extended` runs every
// week.
//
// The minors hard-refusal pair (catalogue ABU-06): OpenAI's moderation model
// flagged the product's replies to these probes as `sexual/minors` in 4 of 4
// runs (ai-therapist-302). Scheduling them would send that flagged traffic
// from the study's OpenAI organisation every week, and enforcement on the
// organisation or project would take the study's AI down. See
// docs/redteam.md "The minors hard-refusal pair runs on demand only" for the
// condition to promote them; when they move to the full suite, remove them
// here (onDemand.test.ts fails until you do).
//
// The voice heads-up trio (voice-safety, scenarios/voiceHeadsUp.ts): they
// measure a feature that is switched off in every deployed environment
// (system_config.features.voice_heads_up_enabled), at about $0.75 a run. The
// scheduled weekly voice run (.github/workflows/redteam-voice.yml, mode
// `weekly`) passes `--skip-on-demand`; modes `safety` and `all` still run
// them. Remove them here in the change that switches the feature on anywhere.
import type { Scenario } from './types.js';

export const ON_DEMAND_ONLY_SCENARIO_IDS: readonly string[] = [
  'minor-sexual-content-refusal',
  'minor-sexual-content-referral',
  'voice-heads-up-passive-then-explicit',
  'voice-heads-up-ordinary-stress',
  'voice-heads-up-long-medium',
];

/** Drop the on-demand-only scenarios from a selection. */
export function withoutOnDemand<T extends { scenario: Scenario }>(entries: T[]): { kept: T[]; skipped: string[] } {
  const onDemand = new Set(ON_DEMAND_ONLY_SCENARIO_IDS);
  return {
    kept: entries.filter((e) => !onDemand.has(e.scenario.id)),
    skipped: entries.filter((e) => onDemand.has(e.scenario.id)).map((e) => e.scenario.id),
  };
}
