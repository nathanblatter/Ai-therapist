// GitHub job-summary rendering for red-team runs (ciSummary.ts writes it to
// $GITHUB_STEP_SUMMARY). Before this, the nightly ran with --allow-fail and the
// only readable result was diff.md inside the artifact, so 2026-11-17 and
// 2026-11-18 were green runs with failed scenarios that nobody saw.
//
// Pure functions over summary.json (+ diff.json); older summaries without the
// variant / progression / judge-stat fields still render.
import { formatDiffMarkdown, type RunDiff } from './diff.js';
import { costNoteLines, judgeStats } from './report.js';
import type { CostBreakdown } from './config.js';
import { aggregateProgression, computeProgression, type ProgressionMetrics } from './progression.js';
import type { Pipeline, Turn } from './types.js';
import { WEEKDAY_NAMES, weekdayIndex, type NightlySample } from './sampling.js';
import { describeJudgeTally, tallyJudges } from './yesNoJudge.js';

/** The subset of summary.json this module reads (report.ts buildSummaryJson). */
export interface SummaryFile {
  suite?: string;
  variant?: { name?: string; description?: string } | null;
  gitSha?: string | null;
  judgeModel?: string;
  /** `auto`, `llm` or `decisions` (yesNoJudge.ts); absent before 2026-11-27. */
  yesNoJudge?: string;
  startedAt?: string;
  /** Sampled nightly (sampling.ts); absent when the whole suite ran. */
  sampling?: NightlySample | null;
  scenarios?: Array<{
    id: string;
    passed: boolean;
    error?: string | null;
    assertions?: Array<{
      id: string;
      passed: boolean;
      gating: boolean;
      detail?: string;
      judge?: 'llm' | 'decisions' | 'llm-fallback' | 'mixed';
      judgeFallback?: string;
    }>;
    judge?: { scores?: Record<string, number | undefined>; progressionRationale?: string } | null;
    progression?: ProgressionMetrics | null;
    pipeline?: Pipeline;
    transcript?: Turn[];
    /** Generated variants (--generated-variants): count toward the verdict
     *  only when gating. */
    generated?: { gating?: boolean } | null;
  }>;
  totals?: {
    estCostUsd?: number;
    /** Since 2026-11-18: the breakdown behind estCostUsd plus its caveats. */
    cost?: Partial<CostBreakdown> & { estimated?: string[]; excluded?: string[] };
  };
}

/** A non-gating generated variant never turns a run red. */
function counts(s: { generated?: { gating?: boolean } | null }): boolean {
  return !s.generated || s.generated.gating === true;
}

export interface RunVerdict {
  scenarios: number;
  failedScenarios: number;
  failedAssertions: number;
  erroredScenarios: number;
  /** True when the run should end red: any failed gating assertion, errored
   *  scenario or failed scenario (a scenario can only fail through one of the
   *  first two, so the third is a backstop). */
  red: boolean;
}

export function verdict(summary: SummaryFile): RunVerdict {
  const scenarios = (summary.scenarios ?? []).filter(counts);
  const failedAssertions = scenarios.reduce(
    (n, s) => n + (s.assertions ?? []).filter((a) => !a.passed && a.gating !== false).length,
    0,
  );
  const erroredScenarios = scenarios.filter((s) => !!s.error).length;
  const failedScenarios = scenarios.filter((s) => !s.passed).length;
  return {
    scenarios: scenarios.length,
    failedScenarios,
    failedAssertions,
    erroredScenarios,
    red: failedAssertions > 0 || erroredScenarios > 0 || failedScenarios > 0,
  };
}

/** One markdown table cell: no pipes or newlines, bounded length. */
function cell(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function ratio(x: { yes: number; of: number }): string {
  return x.of === 0 ? 'n/a' : `${x.yes}/${x.of}`;
}

export interface JobSummaryInput {
  summary: SummaryFile | null;
  /** diff.json when a same-variant baseline was found. */
  diff?: RunDiff | null;
  /** Shown instead of the diff when there is none. */
  noDiffReason?: string;
  /** Heading override, e.g. "Red-team nightly". */
  title?: string;
}

const COST_LABELS: Record<string, string> = {
  'chat-reply': 'Chat replies (therapy model)',
  'in-session': 'In-session app calls (crisis assessor, eligibility, rerank)',
  'post-session': 'Post-session jobs (redaction, insights)',
  persona: 'Persona driver',
  classifier: 'Assertion classifiers',
  judge: 'Judge',
  assistant: 'Admin assistant',
  generation: 'Generated-variant generation',
  voice: 'Voice minutes',
  tts: 'Persona speech',
  other: 'Other',
};

/** The run's cost: total, recorded vs estimated per category, and what is
 *  estimated or left out. Older summaries (no breakdown) get nothing extra. */
export function formatCost(summary: SummaryFile): string[] {
  const cost = summary.totals?.cost;
  if (!cost?.byCategory) return [];
  const lines = ['### Cost', ''];
  const total = summary.totals?.estCostUsd ?? cost.totalUsd ?? 0;
  lines.push(
    `Total $${total.toFixed(2)}: recorded $${(cost.recordedUsd ?? 0).toFixed(2)}, estimated $${(cost.estimatedUsd ?? 0).toFixed(2)}. ` +
      "Recorded means token counts from the API response or the app's own usage table; both are priced from the harness rate table, not read from the invoice.",
    '',
  );
  const rows = Object.entries(cost.byCategory)
    .filter(([, l]) => l && l.usd > 0)
    .sort(([, a], [, b]) => (b?.usd ?? 0) - (a?.usd ?? 0));
  if (rows.length) {
    lines.push('| Category | Cost | Recorded | Estimated | Calls |', '|---|---|---|---|---|');
    for (const [cat, l] of rows) {
      if (!l) continue;
      lines.push(
        `| ${COST_LABELS[cat] ?? cat} | $${l.usd.toFixed(4)} | $${l.recordedUsd.toFixed(4)} | $${l.estimatedUsd.toFixed(4)} | ${l.calls} |`,
      );
    }
    lines.push('');
  }
  const notes = costNoteLines({ estimated: cost.estimated ?? [], excluded: cost.excluded ?? [] });
  if (notes.length) lines.push(...notes.map((n) => `- ${cell(n, 400)}`), '');
  return lines;
}

/** The sampled-run note: which night, N of M, and when the rest are next due. */
export function formatSampling(summary: SummaryFile): string[] {
  const s = summary.sampling;
  if (!s) return [];
  const day = WEEKDAY_NAMES[s.weekday] ?? `day ${s.weekday}`;
  const lines = ['### Sampled run', ''];
  lines.push(
    `**Sampled**: ${s.run.length} of ${s.total} scenarios ran (${day} ${s.date}, ${s.week}, nightly cap ${s.cap}): ` +
      `${s.primaries.length} assigned to tonight, ${s.catchUp.length} catch-up, ${s.repeats.length} repeats. ` +
      'Every scenario in the suite is scheduled at least once per Monday-to-Sunday UTC week (docs/redteam.md "Sampled nightly").',
    '',
  );
  if (!s.historyAvailable)
    lines.push('No previous results were found, so catch-up for missed nights was off tonight.', '');
  if (s.catchUp.length)
    lines.push(`Catch-up (missed earlier this week): ${s.catchUp.map((id) => `\`${id}\``).join(', ')}`, '');
  if (s.deferred.length)
    lines.push(
      `**Deferred** (missed this week, no slot left tonight): ${s.deferred.map((id) => `\`${id}\``).join(', ')}`,
      '',
    );
  const byDate = new Map<string, string[]>();
  for (const [id, date] of Object.entries(s.nextDue ?? {})) byDate.set(date, [...(byDate.get(date) ?? []), id]);
  if (byDate.size) {
    lines.push(`<details><summary>Not run tonight (${s.total - s.run.length}): next due</summary>`, '');
    lines.push('| Next due | Count | Scenarios |', '|---|---|---|');
    for (const date of [...byDate.keys()].sort()) {
      const ids = byDate.get(date)!.sort();
      lines.push(
        `| ${WEEKDAY_NAMES[weekdayIndex(date)]} ${date} | ${ids.length} | ${ids.map((id) => `\`${id}\``).join(', ')} |`,
      );
    }
    lines.push('', '</details>', '');
  }
  return lines;
}

/** Who answered a failing assertion's yes/no question, ahead of its detail. */
function judgeTag(a: { judge?: string; judgeFallback?: string }): string {
  if (!a.judge) return '';
  return `[judge: ${a.judge}${a.judgeFallback ? `, Decisions ${cell(a.judgeFallback, 80)}` : ''}] `;
}

export function formatJobSummary(input: JobSummaryInput): string {
  const title = input.title ?? 'Red-team';
  const { summary } = input;
  const lines: string[] = [];
  if (!summary) {
    lines.push(`## ${title}: no results`);
    lines.push('');
    lines.push('summary.json was not written: the harness crashed before it finished. See the step log.');
    return lines.join('\n') + '\n';
  }

  const variant = summary.variant?.name ?? 'default';
  const v = verdict(summary);
  lines.push(`## ${title}: ${summary.suite ?? 'unknown'} suite, variant \`${variant}\``);
  lines.push('');
  if (summary.variant?.description && variant !== 'default') lines.push(`Variant: ${summary.variant.description}`, '');
  lines.push(
    v.red
      ? `**FAILED**: ${v.failedScenarios} of ${v.scenarios} scenarios failed (${v.failedAssertions} failed assertions, ${v.erroredScenarios} errored scenarios).`
      : `**PASSED**: ${v.scenarios} of ${v.scenarios} scenarios passed.`,
  );
  lines.push('');
  const meta = [
    summary.gitSha ? `commit \`${summary.gitSha.slice(0, 7)}\`` : null,
    summary.judgeModel ? `judge \`${summary.judgeModel}\`` : null,
    typeof summary.totals?.estCostUsd === 'number' ? `cost $${summary.totals.estCostUsd.toFixed(2)}` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(', '), '');
  lines.push(...formatSampling(summary));
  lines.push(...formatCost(summary));

  const scenarios = summary.scenarios ?? [];
  // Which yes/no judge answered, so a run is never ambiguous about it. A
  // summary from before the field existed was judged by the LLM throughout.
  const tally = tallyJudges(scenarios.flatMap((s) => s.assertions ?? []));
  lines.push(
    summary.yesNoJudge
      ? `Yes/no judge (\`${summary.yesNoJudge}\`): ${describeJudgeTally(tally)}.`
      : 'Yes/no judge: this summary predates the judge record; every judged assertion was answered by the LLM judge.',
    '',
  );
  const failing = scenarios
    .filter(counts)
    .flatMap((s) =>
      (s.assertions ?? [])
        .filter((a) => !a.passed && a.gating !== false)
        .map((a) => `| \`${s.id}\` | \`${a.id}\` | ${judgeTag(a)}${cell(a.detail ?? '')} |`),
    );
  if (failing.length) {
    lines.push('### Failing scenarios', '');
    lines.push('| Scenario | Assertion | Detail |', '|---|---|---|', ...failing, '');
  }
  const errored = scenarios.filter((s) => s.error && counts(s));
  if (errored.length) {
    lines.push('### Errored scenarios', '');
    lines.push(...errored.map((s) => `- \`${s.id}\`: ${cell(s.error ?? '', 500)}`), '');
  }
  // A non-gating generated variant's failures are leads, listed with the
  // other non-gating results.
  const nonGating = scenarios.flatMap((s) =>
    (s.assertions ?? [])
      .filter((a) => !a.passed && (a.gating === false || !counts(s)))
      .map((a) => `- \`${s.id}\` / \`${a.id}\`: ${cell(a.detail ?? '', 200)}`),
  );
  if (nonGating.length)
    lines.push('<details><summary>Non-gating failures</summary>', '', ...nonGating, '', '</details>', '');

  const stats = judgeStats(scenarios);
  const dims = Object.keys(stats);
  lines.push('### Judge scores', '');
  if (dims.length === 0) lines.push('No scenario was judged.', '');
  else {
    lines.push('| Dimension | Mean | Min | Judged scenarios |', '|---|---|---|---|');
    for (const d of dims) {
      const note = d === 'session_progression' ? ' (report-only)' : '';
      lines.push(`| ${d}${note} | ${stats[d].mean.toFixed(2)} | ${stats[d].min} | ${stats[d].n} |`);
    }
    const lows = scenarios.flatMap((s) =>
      Object.entries(s.judge?.scores ?? {})
        .filter(([, x]) => typeof x === 'number' && x <= 3)
        .map(([d, x]) => `\`${s.id}\` ${d}=${x}`),
    );
    lines.push('', lows.length ? `Scores of 3 or lower: ${lows.join(', ')}` : 'No score below 4.', '');
  }

  // Summaries written before the metrics existed still carry transcripts.
  const withProg = scenarios
    .map((s) => ({
      ...s,
      progression: s.progression ?? (s.pipeline ? computeProgression(s.pipeline, s.transcript) : null),
    }))
    .filter((s) => s.progression);
  lines.push('### Session progression (report-only)', '');
  if (withProg.length === 0) lines.push('No progression metrics in this summary (chat scenarios only).', '');
  else {
    const t = aggregateProgression(withProg.map((s) => s.progression));
    lines.push(
      `Across ${t.scenarios} chat scenarios: assistant turns with a question ${Math.round((t.meanQuestionTurnShare ?? 0) * 100)}% (mean); ` +
        `opening ends in a question or invitation ${ratio(t.openingInvites)}; ` +
        `reply to a very short participant turn asks or suggests ${ratio(t.shortTurnAdvanced)}; ` +
        `closing summary when the participant ends ${ratio(t.closingSummary)}.`,
      '',
    );
    lines.push('<details><summary>Per scenario</summary>', '');
    lines.push(
      '| Scenario | session_progression | Question turns | Opening invites | Short turns advanced | Closing summary |',
      '|---|---|---|---|---|---|',
    );
    for (const s of withProg) {
      const p = s.progression as ProgressionMetrics;
      lines.push(
        `| \`${s.id}\` | ${s.judge?.scores?.session_progression ?? '-'} | ${Math.round(p.questionTurnShare * 100)}% of ${p.assistantTurns} | ` +
          `${p.openingInvites === null ? '-' : p.openingInvites ? 'yes' : 'no'} | ` +
          `${p.shortTurnAdvanced === null ? '-' : `${p.shortTurnAdvanced}/${p.shortTurns}`} | ` +
          `${p.closingSummary === null ? '-' : p.closingSummary ? 'yes' : 'no'} |`,
      );
    }
    lines.push('', '</details>', '');
  }

  if (input.diff) {
    // Demote the diff's own headings under this summary's.
    lines.push(
      formatDiffMarkdown(input.diff)
        .replace(/^## /gm, '### ')
        .replace(/^### (?!Red-team diff)/gm, '#### '),
    );
  } else {
    lines.push('### Diff vs baseline', '', input.noDiffReason ?? 'No baseline diff for this run.');
  }
  return lines.join('\n') + '\n';
}
