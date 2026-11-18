// Known product gaps: scenarios that expose real product misbehaviour stay in
// the suite, keep running, and keep reporting, without failing the deploy gate
// for a defect that is already filed.
//
// A scenario declares `knownGap` with the Flightdeck bug, the reason, and the
// exact assertion ids expected to fail today. Only those assertions are
// downgraded to non-gating; every other assertion in the scenario still gates,
// so a known gap can never hide a new regression in the same scenario. The
// downgraded results carry `knownGap` in summary.json, appear as `skipped` in
// JUnit with the reference in the message, and are printed in a block of their
// own at the end of the run (and in the GitHub job summary) on every run.
//
// When a listed assertion passes, the block says so: the marker is stale and
// should be removed so the assertion gates again. Removing it is a deliberate
// edit, never automatic, because one passing run of a model-backed check is
// not evidence the gap is closed.
import fs from 'node:fs';
import type { AssertionResult, Scenario, ScenarioResult } from './types.js';

export interface KnownGap {
  /** Flightdeck item for the product bug, e.g. `ai-therapist-301`. */
  flightdeck: string;
  /** What the product does today and which protocol or prompt line it breaks. */
  reason: string;
  /** Assertion ids (exact) expected to fail until the bug is fixed. */
  assertionIds: string[];
}

export const FLIGHTDECK_REF = /^ai-therapist-\d+$/;

/** Problems with a knownGap declaration; empty when it is well formed. */
export function validateKnownGap(scenario: Pick<Scenario, 'id' | 'knownGap' | 'beats' | 'assertFinal'>): string[] {
  const gaps = scenario.knownGap;
  if (!gaps) return [];
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const beat of scenario.beats) for (const a of beat.assertAfter ?? []) declared.add(a.id);
  for (const a of scenario.assertFinal ?? []) declared.add(a.id);
  for (const gap of gaps) {
    if (!FLIGHTDECK_REF.test(gap.flightdeck)) problems.push(`${scenario.id}: flightdeck ref '${gap.flightdeck}'`);
    if (gap.reason.trim().length < 20) problems.push(`${scenario.id}: reason too short to be useful`);
    if (gap.assertionIds.length === 0) problems.push(`${scenario.id}: no assertion ids listed`);
    for (const id of gap.assertionIds) {
      // Judge floors are gated inside the runner on a precomputed flag, so a
      // floor cannot be downgraded here; a judged gap needs its own assertion.
      if (id.startsWith('judge-floor:')) problems.push(`${scenario.id}: judge floors cannot be known gaps (${id})`);
      else if (!declared.has(id)) problems.push(`${scenario.id}: '${id}' is not an assertion this scenario declares`);
    }
  }
  return problems;
}

/**
 * Downgrade the assertions a scenario lists as known gaps. A failing one
 * becomes non-gating and is labelled; a passing one is labelled as stale so
 * the report can say the marker should go. Everything else is untouched.
 */
export function applyKnownGap(scenario: Pick<Scenario, 'knownGap'>, assertions: AssertionResult[]): AssertionResult[] {
  const gaps = scenario.knownGap;
  if (!gaps || gaps.length === 0) return assertions;
  const byId = new Map<string, KnownGap>();
  for (const gap of gaps) for (const id of gap.assertionIds) byId.set(id, gap);
  return assertions.map((a) => {
    const gap = byId.get(a.id);
    if (!gap) return a;
    return a.passed
      ? { ...a, knownGap: gap.flightdeck, detail: `KNOWN GAP ${gap.flightdeck} PASSED THIS RUN: ${a.detail}` }
      : { ...a, gating: false, knownGap: gap.flightdeck, detail: `KNOWN GAP ${gap.flightdeck}: ${a.detail}` };
  });
}

export interface KnownGapLine {
  scenarioId: string;
  assertionId: string;
  flightdeck: string;
  passed: boolean;
  detail: string;
}

export function collectKnownGaps(results: Array<Pick<ScenarioResult, 'id' | 'assertions'>>): KnownGapLine[] {
  const lines: KnownGapLine[] = [];
  for (const r of results) {
    for (const a of r.assertions) {
      if (!a.knownGap) continue;
      lines.push({ scenarioId: r.id, assertionId: a.id, flightdeck: a.knownGap, passed: a.passed, detail: a.detail });
    }
  }
  return lines;
}

/** The end-of-run block. Empty string when the run touched no known gap. */
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
    out.push(` FAILING  ${l.scenarioId} / ${l.assertionId}  [${l.flightdeck}]`);
    out.push(`          ${l.detail}`);
  }
  for (const l of stale) {
    out.push(` PASSED   ${l.scenarioId} / ${l.assertionId}  [${l.flightdeck}]`);
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
