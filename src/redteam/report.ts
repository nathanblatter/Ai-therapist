// Output contract: JUnit XML + summary.json + console table (spec §7).
import fs from 'fs';
import path from 'path';
import type { RedteamConfig } from './config.js';
import type { ScenarioResult } from './types.js';

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  suite: string;
  seed: number;
  judgeModel: string;
  scenarios: ScenarioResult[];
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
    .map(s => {
      const failures = s.assertions.filter(a => !a.passed && a.gating).length;
      const cases = s.assertions
        .map(a => {
          const name = xmlEscape(a.id);
          if (a.passed) return `    <testcase classname="${xmlEscape(s.id)}" name="${name}"/>`;
          const tag = a.gating ? 'failure' : 'skipped';
          return (
            `    <testcase classname="${xmlEscape(s.id)}" name="${name}">\n` +
            `      <${tag} message="${xmlEscape(a.detail)}">${xmlEscape(a.detail)}</${tag}>\n` +
            `    </testcase>`
          );
        })
        .join('\n');
      const errAttr = s.error ? ` errors="1"` : '';
      const errCase = s.error
        ? `\n    <testcase classname="${xmlEscape(s.id)}" name="scenario-execution">\n` +
          `      <error message="${xmlEscape(s.error)}">${xmlEscape(s.error)}</error>\n    </testcase>`
        : '';
      return (
        `  <testsuite name="${xmlEscape(s.id)}" tests="${s.assertions.length}" failures="${failures}"${errAttr} ` +
        `time="${(s.durationMs / 1000).toFixed(3)}">\n${cases}${errCase}\n  </testsuite>`
      );
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="redteam" >\n${suites}\n</testsuites>\n`;
}

export function buildSummaryJson(summary: RunSummary): Record<string, unknown> {
  const scenarios = summary.scenarios.map(s => ({
    id: s.id,
    pipeline: s.pipeline,
    passed: s.passed,
    assertions: s.assertions,
    judge: s.judge,
    costUsd: Number(s.costUsd.toFixed(6)),
    durationMs: s.durationMs,
    error: s.error,
  }));
  const assertionCount = summary.scenarios.reduce((n, s) => n + s.assertions.length, 0);
  const assertionFailures = summary.scenarios.reduce((n, s) => n + s.assertions.filter(a => !a.passed && a.gating).length, 0);
  const passed = summary.scenarios.filter(s => s.passed).length;
  return {
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    suite: summary.suite,
    seed: summary.seed,
    judgeModel: summary.judgeModel,
    scenarios,
    totals: {
      scenarios: summary.scenarios.length,
      passed,
      failed: summary.scenarios.length - passed,
      assertions: assertionCount,
      assertionFailures,
      estCostUsd: Number(summary.scenarios.reduce((n, s) => n + s.costUsd, 0).toFixed(6)),
    },
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
  console.log(` Red-team results — suite=${summary.suite} seed=${summary.seed} judge=${summary.judgeModel}`);
  console.log('─────────────────────────────────────────────────────────────');
  for (const s of summary.scenarios) {
    if (!s.passed) allPass = false;
    const gate = s.assertions.filter(a => a.gating);
    const gp = gate.filter(a => a.passed).length;
    console.log(`${s.passed ? 'PASS' : 'FAIL'}  ${s.id.padEnd(20)} ${gp}/${gate.length} gating  ${(s.durationMs / 1000).toFixed(1)}s  $${s.costUsd.toFixed(4)}`);
    for (const a of s.assertions.filter(x => !x.passed)) {
      console.log(`        ${a.gating ? '✗' : '·'} ${a.id}: ${a.detail}`);
    }
    if (s.error) console.log(`        ! error: ${s.error}`);
    if (s.judge) {
      const scoreStr = Object.entries(s.judge.scores).map(([d, v]) => `${d}=${v}`).join(' ');
      console.log(`        judge: ${scoreStr}`);
    }
  }
  const estCost = summary.scenarios.reduce((n, s) => n + s.costUsd, 0);
  console.log('─────────────────────────────────────────────────────────────');
  console.log(` ${allPass ? 'PASS' : 'FAIL'} — ${summary.scenarios.filter(s => s.passed).length}/${summary.scenarios.length} scenarios, est $${estCost.toFixed(4)}`);
  console.log('─────────────────────────────────────────────────────────────\n');
  return allPass;
}
