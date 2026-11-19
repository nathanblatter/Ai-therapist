// Output contract: JUnit XML + summary.json + console table (spec §7).
import fs from 'fs';
import path from 'path';
import type { RedteamConfig } from './config.js';
import type { ScenarioResult } from './types.js';
import { aggregateProgression } from './progression.js';
import { aggregateVoice } from './voice/aggregate.js';
import type { VariantLabel } from './variants.js';
import type { DiscardedVariant } from './generatedVariants.js';
import { mergeBreakdowns } from './config.js';
import type { RunCostNotes } from './sessionCost.js';
import type { NightlySample } from './sampling.js';

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  suite: string;
  /** Named feature-flag variant the run used (absent in older summaries = default). */
  variant?: VariantLabel;
  seed: number;
  judgeModel: string;
  gitSha?: string | null;
  scenarios: ScenarioResult[];
  /** --generated-variants only: variants the validity guard (or a failed
   *  generation call) discarded. Undefined when generation was off. */
  discardedVariants?: DiscardedVariant[];
  /** Cost provenance for the run (sessionCost.ts): what is estimated and what
   *  is excluded. Absent in older summaries. */
  costNotes?: RunCostNotes;
  /** --sample only: tonight's weekly sample (sampling.ts). Absent = the whole
   *  selected suite ran. */
  sampling?: NightlySample;
}

/** Whether a result can fail the run: every scripted scenario, and a generated
 *  variant only under --gate-generated. */
export function countsTowardGate(s: ScenarioResult): boolean {
  return !s.generated || s.generated.gating;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildJUnit(summary: RunSummary): string {
  const suites = summary.scenarios
    .map((s) => {
      // A non-gating generated variant reports its failures as <skipped> with
      // a marker, the same convention as any other non-gating assertion, so a
      // JUnit consumer never reads it as a scripted-gate regression.
      const gates = countsTowardGate(s);
      const marker = s.generated && !gates ? '[non-gating generated variant] ' : '';
      const failures = gates ? s.assertions.filter((a) => !a.passed && a.gating).length : 0;
      const cases = s.assertions
        .map((a) => {
          const name = xmlEscape(a.id);
          if (a.passed) return `    <testcase classname="${xmlEscape(s.id)}" name="${name}"/>`;
          const tag = a.gating && gates ? 'failure' : 'skipped';
          const msg = xmlEscape(marker + a.detail);
          return (
            `    <testcase classname="${xmlEscape(s.id)}" name="${name}">\n` +
            `      <${tag} message="${msg}">${msg}</${tag}>\n` +
            `    </testcase>`
          );
        })
        .join('\n');
      const errAttr = s.error && gates ? ` errors="1"` : '';
      const errTag = gates ? 'error' : 'skipped';
      const errMsg = s.error ? xmlEscape(marker + s.error) : '';
      const errCase = s.error
        ? `\n    <testcase classname="${xmlEscape(s.id)}" name="scenario-execution">\n` +
          `      <${errTag} message="${errMsg}">${errMsg}</${errTag}>\n    </testcase>`
        : '';
      return (
        `  <testsuite name="${xmlEscape(s.id)}" tests="${s.assertions.length}" failures="${failures}"${errAttr} ` +
        `time="${(s.durationMs / 1000).toFixed(3)}">\n${cases}${errCase}\n  </testsuite>`
      );
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="redteam" >\n${suites}\n</testsuites>\n`;
}

/** Per-dimension mean and minimum of the consensus judge scores across the
 *  scenarios that were judged. Pure; also used by the CI job summary. */
export function judgeStats(
  scenarios: Array<{ judge?: { scores?: Record<string, number | undefined> } | null }>,
): Record<string, { mean: number; min: number; n: number }> {
  const acc: Record<string, number[]> = {};
  for (const s of scenarios) {
    for (const [dim, v] of Object.entries(s.judge?.scores ?? {})) {
      if (typeof v === 'number') (acc[dim] ??= []).push(v);
    }
  }
  const out: Record<string, { mean: number; min: number; n: number }> = {};
  for (const [dim, xs] of Object.entries(acc)) {
    out[dim] = {
      mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)),
      min: Math.min(...xs),
      n: xs.length,
    };
  }
  return out;
}

export function buildSummaryJson(summary: RunSummary): Record<string, unknown> {
  const scenarios = summary.scenarios.map((s) => ({
    id: s.id,
    pipeline: s.pipeline,
    passed: s.passed,
    assertions: s.assertions,
    judge: s.judge,
    costUsd: Number(s.costUsd.toFixed(6)),
    // Per category, recorded vs estimated (config.ts CostBreakdown).
    cost: s.cost ?? null,
    durationMs: s.durationMs,
    error: s.error,
    // Report-only "does the assistant move the session forward" metrics.
    progression: s.progression ?? null,
    // Synthetic persona text + model replies, so a CI failure can be triaged
    // from the artifact after the CI database is gone.
    transcript: s.transcript,
    ...(s.generated ? { generated: s.generated } : {}),
    // GPT-Live runs: the voice evaluation metrics (voice/metrics.ts).
    ...(s.voiceMetrics ? { voiceMetrics: s.voiceMetrics } : {}),
    // Known-gap declaration (knownGap.ts), read by flightdeckReport.ts.
    ...(s.knownGap ? { knownGap: s.knownGap } : {}),
  }));
  // Totals describe the SCRIPTED scenarios only, so they stay comparable run
  // to run whether or not generated variants rode along; those get their own
  // block below.
  const scripted = summary.scenarios.filter((s) => !s.generated);
  const generated = summary.scenarios.filter((s) => s.generated);
  const assertionCount = scripted.reduce((n, s) => n + s.assertions.length, 0);
  const assertionFailures = scripted.reduce((n, s) => n + s.assertions.filter((a) => !a.passed && a.gating).length, 0);
  const passed = scripted.filter((s) => s.passed).length;
  const generatedBlock = summary.discardedVariants
    ? {
        generated: {
          variants: generated.length,
          passed: generated.filter((s) => s.passed).length,
          failed: generated.filter((s) => !s.passed).length,
          gating: generated.some((s) => s.generated?.gating),
          discarded: summary.discardedVariants,
          // Run spend for the variants, generation + guard calls included
          // (discarded attempts too).
          estCostUsd: Number(
            (
              generated.reduce((n, s) => n + s.costUsd, 0) +
              summary.discardedVariants.reduce((n, d) => n + d.costUsd, 0)
            ).toFixed(6),
          ),
        },
      }
    : {};
  return {
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    suite: summary.suite,
    variant: summary.variant ?? null,
    seed: summary.seed,
    judgeModel: summary.judgeModel,
    gitSha: summary.gitSha ?? null,
    ...(summary.sampling ? { sampling: summary.sampling } : {}),
    scenarios,
    totals: {
      scenarios: scripted.length,
      passed,
      failed: scripted.length - passed,
      errored: scripted.filter((s) => !!s.error).length,
      assertions: assertionCount,
      assertionFailures,
      // Kept under its historical name; since 2026-11-18 it is the total of
      // recorded and estimated spend broken down in `cost`.
      estCostUsd: Number(scripted.reduce((n, s) => n + s.costUsd, 0).toFixed(6)),
      cost: {
        ...mergeBreakdowns(scripted.map((s) => s.cost)),
        ...(summary.costNotes ?? {}),
      },
      judge: judgeStats(scripted),
      progression: aggregateProgression(scripted.map((s) => s.progression)),
      // P50/P90 across repeats, per risk band and for crisis turns (voice/aggregate.ts).
      voice: aggregateVoice(scripted),
    },
    ...generatedBlock,
  };
}

export function writeReports(cfg: RedteamConfig, summary: RunSummary): { junitPath: string; summaryPath: string } {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const junitPath = path.join(cfg.outDir, 'redteam.junit.xml');
  const summaryPath = path.join(cfg.outDir, 'summary.json');
  fs.writeFileSync(junitPath, buildJUnit(summary));
  fs.writeFileSync(summaryPath, JSON.stringify(buildSummaryJson(summary), null, 2));
  return { junitPath, summaryPath };
}

/** Compact console table + a PASS/FAIL line. Returns true when the run passed. */
export function printConsole(summary: RunSummary): boolean {
  let allPass = true;
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(
    ` Red-team results — suite=${summary.suite} variant=${summary.variant?.name ?? 'default'} seed=${summary.seed} judge=${summary.judgeModel}`,
  );
  console.log('─────────────────────────────────────────────────────────────');
  const scripted = summary.scenarios.filter((s) => !s.generated);
  const generated = summary.scenarios.filter((s) => s.generated);
  const printScenario = (s: ScenarioResult) => {
    if (!s.passed && countsTowardGate(s)) allPass = false;
    const gate = s.assertions.filter((a) => a.gating);
    const gp = gate.filter((a) => a.passed).length;
    const verdict = s.passed ? 'PASS' : countsTowardGate(s) ? 'FAIL' : 'MISS';
    console.log(
      `${verdict}  ${s.id.padEnd(20)} ${gp}/${gate.length} gating  ${(s.durationMs / 1000).toFixed(1)}s  $${s.costUsd.toFixed(4)}`,
    );
    for (const a of s.assertions.filter((x) => !x.passed)) {
      console.log(`        ${a.gating ? '✗' : '·'} ${a.id}: ${a.detail}`);
    }
    if (s.error) console.log(`        ! error: ${s.error}`);
    if (s.judge) {
      const scoreStr = Object.entries(s.judge.scores)
        .map(([d, v]) => `${d}=${v}`)
        .join(' ');
      console.log(`        judge: ${scoreStr}`);
      for (const [name, per] of Object.entries(s.judge.perJudge ?? {})) {
        console.log(
          `          ${name}: ${Object.entries(per)
            .map(([d, v]) => `${d}=${v}`)
            .join(' ')}`,
        );
      }
    }
    if (s.progression) {
      const p = s.progression;
      console.log(
        `        progression: questions ${Math.round(p.questionTurnShare * 100)}% of ${p.assistantTurns} turns` +
          `, opening invites=${p.openingInvites ?? 'n/a'}` +
          `, short-turn replies advanced=${p.shortTurnAdvanced === null ? 'n/a' : `${p.shortTurnAdvanced}/${p.shortTurns}`}` +
          `, closing summary=${p.closingSummary ?? 'n/a (no close)'}`,
      );
    }
  };
  for (const s of scripted) printScenario(s);
  if (summary.discardedVariants) {
    const gating = generated.some((s) => s.generated?.gating);
    console.log('─────────────────────────────────────────────────────────────');
    console.log(
      ` Generated variants (${gating ? 'GATING' : 'non-gating; MISS = an inherited assertion failed'}): ` +
        `${generated.filter((s) => s.passed).length}/${generated.length} pass, ${summary.discardedVariants.length} discarded`,
    );
    for (const s of generated) {
      printScenario(s);
      console.log(`        script: ${s.generated!.scriptFile}${s.generated!.cached ? ' (cached)' : ''}`);
    }
    for (const d of summary.discardedVariants) console.log(`DROP  ${d.variantId}: ${d.reason}`);
  }
  const estCost =
    summary.scenarios.reduce((n, s) => n + s.costUsd, 0) +
    (summary.discardedVariants ?? []).reduce((n, d) => n + d.costUsd, 0);
  const split = mergeBreakdowns(summary.scenarios.map((s) => s.cost));
  console.log('─────────────────────────────────────────────────────────────');
  console.log(
    ` ${allPass ? 'PASS' : 'FAIL'} — ${scripted.filter((s) => s.passed).length}/${scripted.length} scenarios, cost $${estCost.toFixed(4)}` +
      ` (recorded $${split.recordedUsd.toFixed(4)}, estimated $${split.estimatedUsd.toFixed(4)})`,
  );
  for (const line of costNoteLines(summary.costNotes)) console.log(`   ${line}`);
  console.log('─────────────────────────────────────────────────────────────\n');
  return allPass;
}

/** The run's cost caveats as plain lines (console and job summary). */
export function costNoteLines(notes: Pick<RunCostNotes, 'estimated' | 'excluded'> | undefined | null): string[] {
  if (!notes) return [];
  return [
    ...(notes.estimated ?? []).map((n) => `Estimated: ${n}`),
    ...(notes.excluded ?? []).map((n) => `Not included: ${n}`),
  ];
}
