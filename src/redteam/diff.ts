// Run-to-run diffing for the red-team harness (eval spec G4): compares this
// run's results against a baseline — a previous summary.json on disk, or the
// newest persisted harness_runs row for the same suite — and reports what got
// worse (newly failing assertions, judge-score drops) and what got better.
//
// Pure functions only; the CLI loads the baseline and prints/writes the diff.
import type { HarnessRunRow, HarnessScenarioResultRow } from '../server/db/harnessRuns.queries.js';

/** Judge-score drop (points, 1-5 scale) that counts as a regression. */
export const JUDGE_DROP_THRESHOLD = 1.0;

/** Common shape both baseline sources and the current run are normalized to. */
export interface NormalizedScenario {
  id: string; // label incl. `#vN` suffix for variations
  passed: boolean;
  /** Assertion id -> passed. For DB baselines only FAILED gating assertions are
   *  known (passing ones are not persisted), so this map is partial there. */
  assertions: Record<string, { passed: boolean; gating: boolean; detail: string }>;
  judge: Record<string, number> | null;
  error: string | null;
}

export interface NormalizedRun {
  source: string; // human-readable: file path or "harness run #N (started …)"
  suite: string;
  startedAt: string | null;
  gitSha: string | null;
  /** True when only failed gating assertions are known (DB baseline): an
   *  assertion absent from a scenario's map is then assumed to have passed, and
   *  non-gating assertions are excluded from the comparison. */
  failuresOnly: boolean;
  scenarios: Record<string, NormalizedScenario>;
}

/** The subset of summary.json the diff reads (see report.ts buildSummaryJson). */
export interface SummaryJsonLike {
  suite?: string;
  startedAt?: string;
  gitSha?: string | null;
  scenarios?: Array<{
    id: string;
    passed: boolean;
    assertions?: Array<{ id: string; passed: boolean; gating: boolean; detail?: string }>;
    judge?: { scores?: Record<string, number> } | null;
    error?: string | null;
  }>;
}

export function normalizeSummary(summary: SummaryJsonLike, source: string): NormalizedRun {
  const scenarios: Record<string, NormalizedScenario> = {};
  for (const s of summary.scenarios ?? []) {
    const assertions: NormalizedScenario['assertions'] = {};
    for (const a of s.assertions ?? []) {
      assertions[a.id] = { passed: a.passed, gating: a.gating !== false, detail: a.detail ?? '' };
    }
    scenarios[s.id] = {
      id: s.id,
      passed: s.passed,
      assertions,
      judge: s.judge?.scores ? { ...s.judge.scores } : null,
      error: s.error ?? null,
    };
  }
  return {
    source,
    suite: summary.suite ?? 'unknown',
    startedAt: summary.startedAt ?? null,
    gitSha: summary.gitSha ?? null,
    failuresOnly: false,
    scenarios,
  };
}

/** Rebuild the scenario label the CLI uses (`id`, `id#v2`, …) from a DB row. */
export function scenarioLabel(scenarioId: string, variation: number): string {
  return variation > 0 ? `${scenarioId}#v${variation + 1}` : scenarioId;
}

export function normalizeHarnessRun(run: HarnessRunRow, results: HarnessScenarioResultRow[]): NormalizedRun {
  const scenarios: Record<string, NormalizedScenario> = {};
  for (const r of results) {
    const id = scenarioLabel(r.scenario_id, r.variation);
    const assertions: NormalizedScenario['assertions'] = {};
    for (const f of r.assertion_failures ?? []) assertions[f.id] = { passed: false, gating: true, detail: f.detail };
    scenarios[id] = {
      id,
      passed: r.passed,
      assertions,
      judge: r.judge_scores ? { ...r.judge_scores } : null,
      error: r.error,
    };
  }
  const started = run.started_at instanceof Date ? run.started_at.toISOString() : String(run.started_at);
  return {
    source: `harness run #${run.id} (${run.suite}, started ${started}${run.git_sha ? `, ${run.git_sha.slice(0, 7)}` : ''})`,
    suite: run.suite,
    startedAt: started,
    gitSha: run.git_sha,
    failuresOnly: true,
    scenarios,
  };
}

export interface AssertionChange {
  scenario: string;
  assertion: string;
  gating: boolean;
  detail: string;
}
export interface JudgeChange {
  scenario: string;
  dimension: string;
  before: number;
  after: number;
  delta: number;
}

export interface RunDiff {
  baseline: { source: string; suite: string; startedAt: string | null; gitSha: string | null };
  current: { suite: string; startedAt: string | null; gitSha: string | null };
  /** Baseline and current suites differ — the diff is still computed but flagged. */
  suiteMismatch: boolean;
  newlyFailing: AssertionChange[];
  newlyPassing: AssertionChange[];
  /** Scenarios that errored now but not in the baseline (treated as regressions). */
  newlyErrored: Array<{ scenario: string; error: string }>;
  judgeDrops: JudgeChange[]; // delta <= -threshold
  judgeGains: JudgeChange[]; // delta >= +threshold
  /** Scenarios in the baseline that this run did not execute, and vice versa. */
  missingScenarios: string[];
  newScenarios: string[];
  /** Any gating newly-failing assertion, newly-errored scenario, or judge drop. */
  hasRegressions: boolean;
}

export function diffRuns(
  baseline: NormalizedRun,
  current: NormalizedRun,
  dropThreshold = JUDGE_DROP_THRESHOLD,
): RunDiff {
  const newlyFailing: AssertionChange[] = [];
  const newlyPassing: AssertionChange[] = [];
  const newlyErrored: RunDiff['newlyErrored'] = [];
  const judgeDrops: JudgeChange[] = [];
  const judgeGains: JudgeChange[] = [];
  const missingScenarios: string[] = [];
  const newScenarios: string[] = [];

  for (const id of Object.keys(baseline.scenarios)) if (!current.scenarios[id]) missingScenarios.push(id);

  for (const [id, cur] of Object.entries(current.scenarios)) {
    const base = baseline.scenarios[id];
    if (!base) {
      newScenarios.push(id);
      continue;
    }

    for (const [aid, a] of Object.entries(cur.assertions)) {
      if (baseline.failuresOnly && !a.gating) continue;
      const b = base.assertions[aid];
      const basePassed = b ? b.passed : baseline.failuresOnly ? true : null;
      if (basePassed === null) continue; // assertion unknown in a full baseline: not comparable
      if (!a.passed && basePassed)
        newlyFailing.push({ scenario: id, assertion: aid, gating: a.gating, detail: a.detail });
      if (a.passed && !basePassed)
        newlyPassing.push({ scenario: id, assertion: aid, gating: a.gating, detail: b?.detail ?? '' });
    }

    if (cur.error && !base.error) newlyErrored.push({ scenario: id, error: cur.error });

    if (cur.judge && base.judge) {
      for (const [dim, after] of Object.entries(cur.judge)) {
        const before = base.judge[dim];
        if (typeof before !== 'number' || typeof after !== 'number') continue;
        const delta = after - before;
        if (delta <= -dropThreshold) judgeDrops.push({ scenario: id, dimension: dim, before, after, delta });
        else if (delta >= dropThreshold) judgeGains.push({ scenario: id, dimension: dim, before, after, delta });
      }
    }
  }

  const hasRegressions = newlyFailing.some((f) => f.gating) || newlyErrored.length > 0 || judgeDrops.length > 0;
  return {
    baseline: {
      source: baseline.source,
      suite: baseline.suite,
      startedAt: baseline.startedAt,
      gitSha: baseline.gitSha,
    },
    current: { suite: current.suite, startedAt: current.startedAt, gitSha: current.gitSha },
    suiteMismatch: baseline.suite !== current.suite,
    newlyFailing,
    newlyPassing,
    newlyErrored,
    judgeDrops,
    judgeGains,
    missingScenarios,
    newScenarios,
    hasRegressions,
  };
}

/** Markdown rendering — written to <out>/diff.md and appended to
 *  $GITHUB_STEP_SUMMARY so the nightly's regressions are visible in the job
 *  page instead of buried in --allow-fail logs. */
export function formatDiffMarkdown(diff: RunDiff): string {
  const lines: string[] = [];
  lines.push(`## Red-team diff vs baseline`);
  lines.push('');
  lines.push(
    `Baseline: ${diff.baseline.source}${diff.suiteMismatch ? ` (WARNING: baseline suite \`${diff.baseline.suite}\` differs from current \`${diff.current.suite}\`)` : ''}`,
  );
  lines.push('');
  lines.push(diff.hasRegressions ? `**REGRESSIONS DETECTED**` : `No regressions.`);
  lines.push('');
  const section = (title: string, rows: string[]) => {
    lines.push(`### ${title} (${rows.length})`);
    if (rows.length === 0) lines.push('- none');
    else lines.push(...rows);
    lines.push('');
  };
  section(
    'Newly failing assertions',
    diff.newlyFailing.map(
      (f) => `- \`${f.scenario}\` / \`${f.assertion}\`${f.gating ? '' : ' (non-gating)'}: ${f.detail}`,
    ),
  );
  section(
    'Newly errored scenarios',
    diff.newlyErrored.map((e) => `- \`${e.scenario}\`: ${e.error}`),
  );
  section(
    `Judge-score drops (>= ${JUDGE_DROP_THRESHOLD})`,
    diff.judgeDrops.map((j) => `- \`${j.scenario}\` / ${j.dimension}: ${j.before} -> ${j.after} (${j.delta})`),
  );
  section(
    'Newly passing assertions',
    diff.newlyPassing.map((f) => `- \`${f.scenario}\` / \`${f.assertion}\``),
  );
  section(
    `Judge-score gains (>= ${JUDGE_DROP_THRESHOLD})`,
    diff.judgeGains.map((j) => `- \`${j.scenario}\` / ${j.dimension}: ${j.before} -> ${j.after} (+${j.delta})`),
  );
  if (diff.missingScenarios.length || diff.newScenarios.length) {
    section('Scenario set changes', [
      ...diff.missingScenarios.map((s) => `- not run this time: \`${s}\``),
      ...diff.newScenarios.map((s) => `- new (no baseline): \`${s}\``),
    ]);
  }
  return lines.join('\n');
}

/** Console rendering (same content, plain text). */
export function formatDiffConsole(diff: RunDiff): string {
  return formatDiffMarkdown(diff).replace(/^## /gm, '').replace(/^### /gm, '  ').replace(/\*\*/g, '').replace(/`/g, '');
}
