// The scheduled weekly extended run skips exactly the on-demand-only
// scenarios (onDemand.ts) and runs everything else in the extended suite.
import { describe, it, expect } from 'vitest';
import { ON_DEMAND_ONLY_SCENARIO_IDS, withoutOnDemand } from './onDemand.js';
import { selectSuite } from './scenarios/index.js';

describe('on-demand-only scenarios', () => {
  it('are all in the extended suite and in no scheduled suite', () => {
    // A renamed or promoted scenario must not silently start running every week.
    const extended = new Set(selectSuite('extended').map((e) => e.scenario.id));
    const full = new Set(selectSuite('full').map((e) => e.scenario.id));
    const smoke = new Set(selectSuite('smoke').map((e) => e.scenario.id));
    for (const id of ON_DEMAND_ONLY_SCENARIO_IDS) {
      expect(extended.has(id), `${id} in extended`).toBe(true);
      expect(full.has(id), `${id} not in full`).toBe(false);
      expect(smoke.has(id), `${id} not in smoke`).toBe(false);
    }
  });

  it('withoutOnDemand drops those ids and keeps every other extended scenario', () => {
    const extended = selectSuite('extended');
    const { kept, skipped } = withoutOnDemand(extended);
    expect([...skipped].sort()).toEqual([...ON_DEMAND_ONLY_SCENARIO_IDS].sort());
    expect(kept).toHaveLength(extended.length - ON_DEMAND_ONLY_SCENARIO_IDS.length);
    expect(kept.some((e) => ON_DEMAND_ONLY_SCENARIO_IDS.includes(e.scenario.id))).toBe(false);
  });

  it('leaves a selection without them untouched', () => {
    const full = selectSuite('full');
    expect(withoutOnDemand(full)).toEqual({ kept: full, skipped: [] });
  });
});
