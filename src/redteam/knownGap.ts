// Known gaps in run output. `Scenario.knownGap = { reason, ref }` (types.ts)
// marks a filed product gap the scenario is expected to fail on. Main's
// contract is kept: the scenario stays in its suite and its assertions stay
// gating, because a known gap is not a pass. This module only makes the gap
// impossible to miss in the output:
//   - every failing assertion's detail starts with "KNOWN GAP <ref>";
//   - the result carries `knownGap` with `stillFailing`, written to
//     summary.json;
//   - the console prints a banner listing every known gap in the run, and a
//     known gap that passed is called out as possibly fixed, so its marker
//     gets removed.
import type { Scenario, ScenarioResult } from './types.js';

/** Annotate a scenario's result with its knownGap marker. Pure; never changes
 *  pass/fail or gating. */
export function applyKnownGap(scenario: Pick<Scenario, 'knownGap'>, result: ScenarioResult): ScenarioResult {
  const gap = scenario.knownGap;
  if (!gap) return result;
  const failing = !result.passed || !!result.error;
  return {
    ...result,
    assertions: result.assertions.map((a) => (a.passed ? a : { ...a, detail: `KNOWN GAP ${gap.ref}: ${a.detail}` })),
    knownGap: { reason: gap.reason, ref: gap.ref, stillFailing: failing },
  };
}

/** Console banner for every known-gap result in a run ('' when none). */
export function formatKnownGaps(results: ScenarioResult[]): string {
  const gaps = results.filter((r) => r.knownGap);
  if (gaps.length === 0) return '';
  const lines = gaps.map((r) => {
    const g = r.knownGap!;
    const state = g.stillFailing ? 'STILL FAILING' : 'PASSED this run: the gap may be fixed, remove the marker';
    return `  ${r.id} [${g.ref}] ${state}\n      ${g.reason}`;
  });
  return `\n!!! KNOWN GAPS (${gaps.length}) - filed product misbehaviour, still gating:\n${lines.join('\n')}\n`;
}
