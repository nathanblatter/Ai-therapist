// Known gaps: a scenario that exposes real product misbehaviour stays in the
// suite, marked `knownGap: { reason, ref }`, instead of being weakened or
// dropped. A known-gap scenario that still fails:
//   - does NOT fail the run (its gating failures are downgraded to non-gating,
//     so JUnit lists them as skipped with the reason, and the exit code and
//     deploy gate are unaffected);
//   - IS reported loudly: every downgraded assertion's detail starts with
//     "KNOWN GAP <ref>", the result carries `knownGap` (with stillFailing),
//     and the console prints a banner listing every known gap in the run.
// A known-gap scenario that passes is reported too ("may be fixed"), so the
// marker gets removed and the scenario starts gating again.
import type { Scenario, ScenarioResult } from './types.js';

/** Apply a scenario's knownGap marker to its result. Pure. Errors (the run
 *  itself broke) are never masked: a known gap covers behaviour, not crashes. */
export function applyKnownGap(scenario: Pick<Scenario, 'knownGap'>, result: ScenarioResult): ScenarioResult {
  const gap = scenario.knownGap;
  if (!gap) return result;
  if (result.error) return { ...result, knownGap: { ...gap, stillFailing: true } };
  const failing = result.assertions.filter((a) => !a.passed && a.gating);
  if (failing.length === 0) return { ...result, knownGap: { ...gap, stillFailing: false } };
  return {
    ...result,
    passed: true,
    assertions: result.assertions.map((a) =>
      !a.passed && a.gating ? { ...a, gating: false, detail: `KNOWN GAP ${gap.ref}: ${a.detail}` } : a,
    ),
    knownGap: { ...gap, stillFailing: true },
  };
}

/** Console banner for every known-gap result in a run ('' when none). */
export function formatKnownGaps(results: ScenarioResult[]): string {
  const gaps = results.filter((r) => r.knownGap);
  if (gaps.length === 0) return '';
  const lines = gaps.map((r) => {
    const g = r.knownGap!;
    const state = g.stillFailing
      ? 'STILL FAILING (not gating)'
      : 'PASSED this run: the gap may be fixed, remove the marker';
    return `  ${r.id} [${g.ref}] ${state}\n      ${g.reason}`;
  });
  return `\n!!! KNOWN GAPS (${gaps.length}) - real product misbehaviour kept in the suite:\n${lines.join('\n')}\n`;
}
