// Rolling baseline: each scenario's most recent result, carried night to night
// in <out>/rolling-baseline.json. A sampled nightly runs a different subset
// each night, so the previous night's summary.json alone would hold no prior
// result for most of tonight's scenarios. The rolling file merges the previous
// rolling file with tonight's results, so the diff compares every scenario with
// its own most recent prior run, and the sampler knows what already ran this
// week (sampling.ts catch-up).
//
// Pure functions plus two small file helpers; unit-tested in rollingBaseline.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSummary, type NormalizedRun, type NormalizedScenario, type SummaryJsonLike } from './diff.js';

export const ROLLING_BASELINE_FILE = 'rolling-baseline.json';

export interface RollingEntry extends NormalizedScenario {
  /** startedAt of the run that produced this result. */
  ranAt: string;
  gitSha: string | null;
}

export interface RollingBaseline {
  version: 1;
  suite: string;
  variant: string;
  updatedAt: string;
  /** Scenario label (`id`, `id#v2`, ...) -> most recent result. */
  scenarios: Record<string, RollingEntry>;
}

/** Strip the `#vN` variation suffix. */
export function baseScenarioId(label: string): string {
  return label.replace(/#v\d+$/, '');
}

/** A plain summary.json as a rolling baseline (older artifacts have no rolling file). */
export function rollingFromSummary(summary: SummaryJsonLike, source = 'summary.json'): RollingBaseline {
  const run = normalizeSummary(summary, source);
  const ranAt = run.startedAt ?? new Date(0).toISOString();
  const scenarios: Record<string, RollingEntry> = {};
  for (const [label, s] of Object.entries(run.scenarios)) scenarios[label] = { ...s, ranAt, gitSha: run.gitSha };
  return { version: 1, suite: run.suite, variant: run.variant, updatedAt: ranAt, scenarios };
}

/**
 * Merge tonight's results over the prior rolling baseline. A prior of another
 * suite or variant is dropped (never mix variants). Labels whose scenario is no
 * longer in the suite are pruned so retired scenarios do not linger forever.
 */
export function mergeRolling(
  prior: RollingBaseline | null,
  current: NormalizedRun,
  suiteIds: ReadonlySet<string>,
): RollingBaseline {
  const usable = prior && prior.suite === current.suite && prior.variant === current.variant ? prior : null;
  const ranAt = current.startedAt ?? new Date().toISOString();
  const scenarios: Record<string, RollingEntry> = {};
  for (const [label, e] of Object.entries(usable?.scenarios ?? {}))
    if (suiteIds.has(baseScenarioId(label))) scenarios[label] = e;
  for (const [label, s] of Object.entries(current.scenarios))
    scenarios[label] = { ...s, ranAt, gitSha: current.gitSha };
  return { version: 1, suite: current.suite, variant: current.variant, updatedAt: ranAt, scenarios };
}

/** The rolling baseline as a diff baseline. */
export function rollingToNormalized(r: RollingBaseline, source: string): NormalizedRun {
  const scenarios: Record<string, NormalizedScenario> = {};
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const [label, e] of Object.entries(r.scenarios)) {
    const { ranAt: _ranAt, gitSha: _gitSha, ...s } = e;
    scenarios[label] = s;
    if (!oldest || e.ranAt < oldest) oldest = e.ranAt;
    if (!newest || e.ranAt > newest) newest = e.ranAt;
  }
  const span = oldest && newest && oldest !== newest ? `, results from ${oldest} to ${newest}` : '';
  return {
    source: `${source} (each scenario's most recent prior result${span})`,
    suite: r.suite,
    variant: r.variant,
    startedAt: newest,
    gitSha: null,
    failuresOnly: false,
    scenarios,
  };
}

/** Scenario id -> most recent ranAt, for the sampler's catch-up. */
export function lastRunById(r: RollingBaseline): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, e] of Object.entries(r.scenarios)) {
    const id = baseScenarioId(label);
    if (!out[id] || e.ranAt > out[id]) out[id] = e.ranAt;
  }
  return out;
}

/**
 * Load the rolling baseline that sits next to a summary.json (or in a
 * directory), falling back to the summary.json itself. Null when neither is
 * readable.
 */
export function loadRollingBaseline(summaryPath: string): { rolling: RollingBaseline; file: string } | null {
  const dir =
    fs.existsSync(summaryPath) && fs.statSync(summaryPath).isDirectory() ? summaryPath : path.dirname(summaryPath);
  const rollingFile = path.join(dir, ROLLING_BASELINE_FILE);
  try {
    const r = JSON.parse(fs.readFileSync(rollingFile, 'utf8')) as RollingBaseline;
    if (r && r.version === 1 && r.scenarios) return { rolling: r, file: rollingFile };
  } catch {
    /* fall back to summary.json */
  }
  const summaryFile = summaryPath.endsWith('.json') ? summaryPath : path.join(dir, 'summary.json');
  try {
    const s = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as SummaryJsonLike;
    return { rolling: rollingFromSummary(s, summaryFile), file: summaryFile };
  } catch {
    return null;
  }
}
