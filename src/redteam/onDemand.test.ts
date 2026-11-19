// The scheduled weekly runs skip exactly the on-demand-only scenarios
// (onDemand.ts) and run everything else in their suite.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ON_DEMAND_ONLY_SCENARIO_IDS, withoutOnDemand } from './onDemand.js';
import { selectSuite } from './scenarios/index.js';

/** The scheduled suites that pass --skip-on-demand. */
const SKIPPING_SUITES = ['extended', 'voice-safety'] as const;

describe('on-demand-only scenarios', () => {
  it('are all in a suite whose scheduled run skips them, and in no other scheduled suite', () => {
    // A renamed or promoted scenario must not silently start running every week.
    const skipping = new Set(SKIPPING_SUITES.flatMap((s) => selectSuite(s).map((e) => e.scenario.id)));
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(selectSuite('smoke').map((e) => e.scenario.id));
    const voice = new Set(selectSuite('voice').map((e) => e.scenario.id));
    for (const id of ON_DEMAND_ONLY_SCENARIO_IDS) {
      expect(skipping.has(id), `${id} in extended or voice-safety`).toBe(true);
      expect(full.has(id), `${id} not in full`).toBe(false);
      expect(smoke.has(id), `${id} not in smoke`).toBe(false);
      expect(voice.has(id), `${id} not in voice (the in-app nightly default)`).toBe(false);
    }
  });

  it.each(SKIPPING_SUITES)('withoutOnDemand drops those ids from %s and keeps every other scenario', (suite) => {
    const entries = selectSuite(suite);
    const inSuite = ON_DEMAND_ONLY_SCENARIO_IDS.filter((id) => entries.some((e) => e.scenario.id === id));
    expect(inSuite.length).toBeGreaterThan(0);
    const { kept, skipped } = withoutOnDemand(entries);
    expect([...skipped].sort()).toEqual([...inSuite].sort());
    expect(kept).toHaveLength(entries.length - inSuite.length);
    expect(kept.some((e) => ON_DEMAND_ONLY_SCENARIO_IDS.includes(e.scenario.id))).toBe(false);
  });

  it('the voice heads-up trio is on demand only (the feature is off everywhere)', () => {
    const headsUp = selectSuite('voice-safety')
      .map((e) => e.scenario.id)
      .filter((id) => id.startsWith('voice-heads-up-'));
    expect(headsUp.length).toBe(3);
    for (const id of headsUp) expect(ON_DEMAND_ONLY_SCENARIO_IDS).toContain(id);
  });

  it('the scheduled runs of both suites pass --skip-on-demand', () => {
    const extended = readFileSync('.github/workflows/redteam-extended.yml', 'utf8');
    expect(extended).toMatch(/redteam:extended -- [^\n]*--skip-on-demand/);
    const voice = readFileSync('.github/workflows/redteam-voice.yml', 'utf8');
    // The schedule runs mode `weekly`; that mode adds the flag.
    expect(voice).toMatch(/MODE: \$\{\{ inputs\.mode \|\| 'weekly' \}\}/);
    expect(voice).toMatch(/\[ "\$MODE" = weekly \] && skip="--skip-on-demand"/);
    expect(voice).toMatch(/cli\.ts --suite "\$suite" [^\n]*\$skip/);
  });

  it('leaves a selection without them untouched', () => {
    const full = selectSuite('full');
    expect(withoutOnDemand(full)).toEqual({ kept: full, skipped: [] });
  });
});
