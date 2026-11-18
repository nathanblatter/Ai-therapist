// Known product gaps (`Scenario.knownGap: { reason, ref }`, docs/redteam.md).
//
// The base convention: a scenario that exposes a filed product bug stays in
// its suite and stays gating, and reports name the gap so a new failure
// stands out. That suits suites that are not a deploy gate.
//
// This module adds the optional `assertionIds`: the exact assertions expected
// to fail until the bug is fixed. Only those are downgraded to non-gating;
// every other assertion in the scenario still gates, so a known gap can never
// hide a new regression in the same scenario. The downgraded results carry
// `knownGap` in summary.json, appear as `skipped` in JUnit with the reference
// in the message, and are printed in a block of their own at the end of every
// run (and in the GitHub job summary).
//
// When a listed assertion passes, the block says so: the marker is stale and
// should be removed so the assertion gates again. Removing it is a deliberate
// edit, never automatic, because one passing run of a model-backed check is
// not evidence the gap is closed.
import fs from 'node:fs';
import type { AssertionResult, Scenario, ScenarioResult } from './types.js';

export interface KnownGap {
  /** What the product does today and which protocol or prompt line it breaks. */
  reason: string;
  /** Flightdeck item for the product bug, e.g. `ai-therapist-301`. */
  ref: string;
  /** Assertion ids (exact) that report without gating until the bug is fixed.
   *  Omitted: the scenario is only labelled and every assertion still gates. */
  assertionIds?: string[];
}

export const FLIGHTDECK_REF = /^ai-therapist-\d+$/;

/** Problems with a knownGap declaration; empty when it is well formed. */
export function validateKnownGap(scenario: Pick<Scenario, 'id' | 'knownGap' | 'beats' | 'assertFinal'>): string[] {
  const gap = scenario.knownGap;
  if (!gap) return [];
  const problems: string[] = [];
  if (!FLIGHTDECK_REF.test(gap.ref)) problems.push(`${scenario.id}: flightdeck ref '${gap.ref}'`);
  if (gap.reason.trim().length < 20) problems.push(`${scenario.id}: reason too short to be useful`);
  if (!gap.assertionIds) return problems;
  if (gap.assertionIds.length === 0) problems.push(`${scenario.id}: assertionIds is empty`);
  const declared = new Set<string>();
  for (const beat of scenario.beats) for (const a of beat.assertAfter ?? []) declared.add(a.id);
  for (const a of scenario.assertFinal ?? []) declared.add(a.id);
  for (const id of gap.assertionIds) {
    // Judge floors are gated inside the runner on a precomputed flag, so a
    // floor cannot be downgraded here; a judged gap needs its own assertion.
    if (id.startsWith('judge-floor:')) problems.push(`${scenario.id}: judge floors cannot be listed (${id})`);
    else if (!declared.has(id)) problems.push(`${scenario.id}: '${id}' is not an assertion this scenario declares`);
  }
  return problems;
}

/**
 * Downgrade the assertions a scenario lists in `knownGap.assertionIds`. A
 * failing one becomes non-gating and is labelled; a passing one is labelled as
 * stale so the report can say the marker should go. Everything else, and every
 * scenario whose knownGap lists no ids, is untouched.
 */
export function applyKnownGap(scenario: Pick<Scenario, 'knownGap'>, assertions: AssertionResult[]): AssertionResult[] {
  const gap = scenario.knownGap;
  if (!gap?.assertionIds?.length) return assertions;
  const listed = new Set(gap.assertionIds);
  return assertions.map((a) => {
    if (!listed.has(a.id)) return a;
    return a.passed
      ? { ...a, knownGap: gap.ref, detail: `KNOWN GAP ${gap.ref} PASSED THIS RUN: ${a.detail}` }
      : { ...a, gating: false, knownGap: gap.ref, detail: `KNOWN GAP ${gap.ref}: ${a.detail}` };
  });
}

export interface KnownGapLine {
  scenarioId: string;
  assertionId: string;
  ref: string;
  passed: boolean;
  detail: string;
}

export function collectKnownGaps(results: Array<Pick<ScenarioResult, 'id' | 'assertions'>>): KnownGapLine[] {
  const lines: KnownGapLine[] = [];
  for (const r of results) {
    for (const a of r.assertions) {
      if (!a.knownGap) continue;
      lines.push({ scenarioId: r.id, assertionId: a.id, ref: a.knownGap, passed: a.passed, detail: a.detail });
    }
  }
  return lines;
}

/** The end-of-run block. Empty string when the run touched no listed gap. */
export function formatKnownGaps(lines: KnownGapLine[]): string {
  if (lines.length === 0) return '';
  const failing = lines.filter((l) => !l.passed);
  const stale = lines.filter((l) => l.passed);
  const out: string[] = [];
  out.push('=============================================================');
  out.push(
    ` KNOWN GAPS: ${failing.length} assertion(s) FAILING on filed product bugs (reported, not gating)` +
      (stale.length ? `; ${stale.length} passed this run` : ''),
  );
  out.push('=============================================================');
  for (const l of failing) {
    out.push(` FAILING  ${l.scenarioId} / ${l.assertionId}  [${l.ref}]`);
    out.push(`          ${l.detail}`);
  }
  for (const l of stale) {
    out.push(` PASSED   ${l.scenarioId} / ${l.assertionId}  [${l.ref}]`);
    out.push(`          if the bug is fixed, remove this id from the scenario's knownGap so it gates again`);
  }
  out.push('=============================================================');
  return out.join('\n');
}

/** Print the block and mirror it into the GitHub job summary when present. */
export function reportKnownGaps(results: Array<Pick<ScenarioResult, 'id' | 'assertions'>>): void {
  const block = formatKnownGaps(collectKnownGaps(results));
  if (!block) return;
  console.log('\n' + block + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n### Red-team known gaps\n\n```\n' + block + '\n```\n');
    } catch {
      /* best-effort */
    }
  }
}
