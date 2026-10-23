// Weekly PI digest (eval spec WP7, section 6). The lighter weekly sibling of
// the IRB continuing-review packet: one markdown document per (org, week
// ending) that a researcher can forward to the PI as-is, plus the structured
// numbers it was rendered from. Nothing here sends mail: Nathan forwards it.
//
// Rules shared with the IRB packet and honoured by every section:
//   - aggregates only (counts, means, kappas) - no session ids, participant
//     ids, usernames, emails or transcript text are selected or printed;
//   - scope = the IRB packet's (SESSION_SCOPE: demo + sandbox excluded,
//     org-scoped, unattributed rows only for the irb-study org), reusing
//     getIrbSafetyCounts / getIrbMonitoringCounts rather than new SQL;
//   - study-global tables (drift alerts, harness runs, calibration pairs)
//     are windowed only, as in the packet;
//   - every free-text field that reaches the page goes through
//     scrubIdentifiers as a last line of defence.
//
// Scheduling follows harnessRunner.service.ts: an in-process 5-minute tick,
// config under system_config.evals.digest_schedule, debounced through the
// weekly_digests table so a restart never double-generates.
import { pool } from '../config/db.js';
import { gitSha } from '../utils/gitSha.js';
import { getSystemConfig, invalidateConfigCache } from '../utils/sessionHelpers.js';
import { createLogger } from '../utils/logger.js';
import { getIrbStudyOrgId, getOrganizationById } from '../db/organizations.queries.js';
import {
  getIrbSafetyCounts,
  getIrbMonitoringCounts,
  type IrbWindow,
  type IrbMonitoringCounts,
} from '../db/irbPacket.queries.js';
import { scrubIdentifiers } from './irbPacket.service.js';
import {
  getWeeklyEvalScores,
  getSessionsEvaluatedCount,
  getNightlyRunPairs,
  getCrisisAdjudicationCounts,
  insertWeeklyDigest,
  getLastScheduledDigestAt,
  type WeeklyEvalScoreRow,
  type NightlyRunPair,
  type WeeklyDigestRow,
} from '../db/weeklyDigest.queries.js';
import { EVAL_DIMENSIONS, EVAL_PROMPT_VERSION, DEFAULT_JUDGE_MODELS } from './sessionEval.service.js';
import {
  computeCalibrationReport,
  computeJudgeAgreementReport,
  KAPPA_BANDS,
  type CalibrationReport,
  type JudgeAgreementReport,
} from './evalCalibration.service.js';

const log = createLogger('weeklyDigest');

/** Human-judge calibration is "established" at this many paired ratings
 *  (eval spec WP2 accept criterion) ... */
export const MIN_PAIRED_RATINGS = 20;
/** ... and this weighted kappa on every dimension (eval spec WP6 gate). */
export const TARGET_KAPPA = 0.6;
/** Weeks of history behind the "prior" column in the trend table. */
export const TREND_PRIOR_WEEKS = 4;

const DIMENSION_LABELS: Record<string, string> = {
  safety_protocol: 'Safety protocol',
  empathy: 'Empathy / reflective listening',
  modality_fidelity: 'Modality fidelity',
  disclaimer_compliance: 'Disclaimer compliance',
  non_directiveness: 'Non-directiveness',
  clinical_claims: 'No hallucinated clinical claims',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildWeeklyDigestInput {
  /** YYYY-MM-DD, the last day of the week (inclusive, UTC). */
  weekEnding: string;
  orgId: number;
  /** Overridable for deterministic tests. */
  generatedAt?: string;
}

export interface DigestDimensionTrend {
  dimension: string;
  label: string;
  /** Mean consensus score this week; null when no evals. */
  this_week: number | null;
  this_week_n: number;
  /** Pooled mean over the prior TREND_PRIOR_WEEKS weeks; null when none. */
  prior: number | null;
  prior_n: number;
  /** this_week - prior; null unless both exist. */
  delta: number | null;
}

export interface DigestHarnessSuite {
  suite: string;
  runs: number;
  scenarios: number;
  passed: number;
  pass_rate: number | null;
  last_run_at: string | null;
}

export interface DigestNightlyDiff {
  suite: string;
  latest: { started_at: string; pass_count: number; scenario_count: number; git_sha: string | null };
  previous: { started_at: string; pass_count: number; scenario_count: number; git_sha: string | null } | null;
  /** latest pass rate - previous pass rate (0..1); null without a previous run. */
  pass_rate_delta: number | null;
}

export interface DigestGap {
  key: string;
  label: string;
  /** True when the gap is still open. */
  open: boolean;
  detail: string;
}

export interface WeeklyDigestData {
  meta: {
    generated_at: string;
    git_sha: string;
    week_ending: string;
    period: { from: string; to: string };
    organization: { id: number; name: string | null; is_irb_study_org: boolean };
    prompt_version: string;
    sources: Record<string, string>;
  };
  sessions_evaluated: number;
  trend: DigestDimensionTrend[];
  judge_agreement: {
    judges: string[];
    session_count: number;
    pairs: { judge_a: string; judge_b: string; n: number; overall_kappa: number | null; major_disagreement_pct: number | null }[];
    high_disagreement_count: number;
  };
  drift: IrbMonitoringCounts['drift_alerts'];
  harness: { suites: DigestHarnessSuite[]; nightly_diff: DigestNightlyDiff[] };
  crisis: {
    events_by_severity: { severity: string; n: number }[];
    events_by_type: { event_type: string; n: number }[];
    total: number;
    pages_sent: number;
    /** null = adjudication not yet enabled (table absent). */
    adjudication: { outcome: string; n: number }[] | null;
  };
  calibration: {
    pair_count: number;
    session_count: number;
    min_pairs: number;
    target_kappa: number;
    overall_kappa: number | null;
    dimensions: { dimension: string; label: string; n: number; kappa: number | null; band: string }[];
    meets_pair_rule: boolean;
    meets_kappa_rule: boolean;
  };
  gaps: DigestGap[];
}

export interface WeeklyDigest {
  markdown: string;
  data: WeeklyDigestData;
}

const SOURCES: Record<string, string> = {
  sessions_evaluated: 'session_evals consensus rows (created_at in week; prompt version pinned) x therapy_sessions scope',
  trend: 'session_evals consensus rubric scores per week bucket, this week vs pooled prior 4 weeks',
  judge_agreement: 'session_eval_judges via evalCalibration.computeJudgeAgreementReport (study-global)',
  drift: 'eval_drift_alerts (study-global; same query as IRB packet section 8)',
  harness: 'harness_runs (dry runs excluded; same query as IRB packet section 8) + nightly run-to-run comparison',
  crisis: 'crisis_events x therapy_sessions scope (same query as IRB packet section 4); crisis_event_adjudications when present',
  calibration: 'session_human_ratings x session_evals via evalCalibration.computeCalibrationReport (study-global)',
  gaps: 'system_config.evals flags + the calibration thresholds above',
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** The [from, to] ISO window for a week ending on `weekEnding` (UTC days). */
export function weekWindow(weekEnding: string): { from: string; to: string } {
  const to = new Date(`${weekEnding}T23:59:59.999Z`);
  const from = new Date(`${weekEnding}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 6);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** YYYY-MM-DD of the most recent Sunday strictly before `now` (UTC), i.e. the
 *  last complete week when the digest runs on a Monday morning. */
export function defaultWeekEnding(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Sunday -> previous Sunday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function isValidWeekEnding(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Per-dimension trend: this week's mean vs the pooled mean of the prior
 * weeks (weighted by eval count, so a quiet week does not swing the baseline).
 * Rows for `weekEnding` are "this week"; every other row is "prior".
 */
export function computeTrend(rows: WeeklyEvalScoreRow[], weekEnding: string): DigestDimensionTrend[] {
  return EVAL_DIMENSIONS.map(dimension => {
    let thisSum = 0; let thisN = 0; let priorSum = 0; let priorN = 0;
    for (const r of rows) {
      if (r.dimension !== dimension || r.n <= 0) continue;
      if (r.week_ending === weekEnding) { thisSum += r.mean_score * r.n; thisN += r.n; }
      else { priorSum += r.mean_score * r.n; priorN += r.n; }
    }
    const thisWeek = thisN ? thisSum / thisN : null;
    const prior = priorN ? priorSum / priorN : null;
    return {
      dimension,
      label: DIMENSION_LABELS[dimension] ?? dimension,
      this_week: thisWeek,
      this_week_n: thisN,
      prior,
      prior_n: priorN,
      delta: thisWeek !== null && prior !== null ? thisWeek - prior : null,
    };
  });
}

export function kappaBand(kappa: number | null): string {
  if (kappa === null) return 'n/a';
  const band = KAPPA_BANDS.find(b => kappa >= b.min);
  return band?.label ?? 'n/a';
}

export function nightlyDiffOf(pair: NightlyRunPair): DigestNightlyDiff {
  const rate = (p: { pass_count: number; scenario_count: number }) => (p.scenario_count > 0 ? p.pass_count / p.scenario_count : null);
  const a = rate(pair.latest);
  const b = pair.previous ? rate(pair.previous) : null;
  return {
    suite: pair.suite,
    latest: { ...pair.latest, started_at: pair.latest.started_at.toISOString() },
    previous: pair.previous ? { ...pair.previous, started_at: pair.previous.started_at.toISOString() } : null,
    pass_rate_delta: a !== null && b !== null ? a - b : null,
  };
}

/** The fixed open-gaps checklist (eval spec section 3 gaps that are config or
 *  threshold driven). Everything else in the spec is a code change, not a flag. */
export function computeGaps(evalsConfig: Record<string, unknown>, calibration: WeeklyDigestData['calibration'], adjudicationEnabled: boolean): DigestGap[] {
  const flag = (k: string) => evalsConfig[k] === true;
  const schedule = (evalsConfig.harness_schedule ?? {}) as { enabled?: unknown };
  const digest = (evalsConfig.digest_schedule ?? {}) as { enabled?: unknown };
  // Ensemble is on unless judge_models is explicitly set to fewer than two
  // models (sessionEval.service.ts falls back to DEFAULT_JUDGE_MODELS).
  const judges = Array.isArray(evalsConfig.judge_models) ? evalsConfig.judge_models.length : DEFAULT_JUDGE_MODELS.length;
  return [
    { key: 'auto_eval', label: 'Automatic session evals', open: !flag('auto_run_enabled'), detail: flag('auto_run_enabled') ? 'enabled (evals.auto_run_enabled)' : 'off: sessions are scored only on demand (evals.auto_run_enabled = false)' },
    { key: 'drift_paging', label: 'Drift alert paging', open: !flag('drift_page_enabled'), detail: flag('drift_page_enabled') ? 'enabled (evals.drift_page_enabled)' : 'off: drift alerts are admin-visible only (evals.drift_page_enabled = false)' },
    { key: 'nightly_harness', label: 'Nightly harness schedule', open: schedule.enabled !== true, detail: schedule.enabled === true ? 'enabled (evals.harness_schedule)' : 'off: red-team suites run only when started by hand' },
    { key: 'weekly_digest', label: 'Weekly digest schedule', open: digest.enabled !== true, detail: digest.enabled === true ? 'enabled (evals.digest_schedule)' : 'off: this digest was generated by hand' },
    { key: 'judge_ensemble', label: 'Judge ensemble', open: judges < 2, detail: judges < 2 ? 'single judge: no judge-vs-judge agreement available' : `${judges} judges configured` },
    { key: 'paired_ratings', label: `Human ratings paired with judge scores (>= ${calibration.min_pairs})`, open: !calibration.meets_pair_rule, detail: `${calibration.pair_count} paired ratings so far` },
    { key: 'kappa', label: `Human-judge kappa >= ${calibration.target_kappa} on every dimension`, open: !calibration.meets_kappa_rule, detail: calibration.meets_kappa_rule ? 'met' : 'not yet met: live quality monitoring stays gated (eval spec WP6)' },
    { key: 'adjudication', label: 'Crisis event adjudication', open: !adjudicationEnabled, detail: adjudicationEnabled ? 'enabled' : 'adjudication not yet enabled (eval spec WP2)' },
  ];
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const f2 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(2));
const pct = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '-' : `${Math.round(v * 100)}%`);
const signed = (v: number | null): string => (v === null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '-');
/** Markdown table cell: scrubbed, pipes and newlines neutralised. */
const cell = (v: string | number | null | undefined): string =>
  scrubIdentifiers(v === null || v === undefined ? '-' : String(v)).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function table(headers: string[], rows: (string | number | null)[][]): string[] {
  const out = [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  return out;
}

export function renderWeeklyDigestMarkdown(d: WeeklyDigestData): string {
  const L: string[] = [];
  const orgName = d.meta.organization.name ? scrubIdentifiers(d.meta.organization.name) : `organization ${d.meta.organization.id}`;
  L.push(`# Weekly quality digest - week ending ${d.meta.week_ending}`);
  L.push('');
  L.push(`Period ${day(d.meta.period.from)} to ${day(d.meta.period.to)} (UTC). Scope: ${orgName}; demo and sandbox traffic excluded. ` +
    'All figures are aggregates; no participant, session or staff identifiers appear in this document.');
  L.push('');

  // 1. Sessions evaluated + trend
  L.push('## 1. Sessions evaluated and score trend');
  L.push('');
  L.push(`**${d.sessions_evaluated}** session${d.sessions_evaluated === 1 ? '' : 's'} received an LLM-judge quality score this week ` +
    `(judge prompt ${d.meta.prompt_version}). Scores are 1-5; "prior" pools the ${TREND_PRIOR_WEEKS} weeks before this one.`);
  L.push('');
  if (d.trend.every(t => t.this_week === null && t.prior === null)) {
    L.push('No scored sessions in this week or the prior four, so there is no trend to report.');
  } else {
    L.push(...table(
      ['Dimension', 'This week', 'n', 'Prior 4 weeks', 'n', 'Change'],
      d.trend.map(t => [t.label, f2(t.this_week), t.this_week_n, f2(t.prior), t.prior_n, signed(t.delta)]),
    ));
  }
  L.push('');

  // 2. Judge agreement
  L.push('## 2. Judge agreement');
  L.push('');
  const ja = d.judge_agreement;
  if (ja.pairs.length === 0) {
    L.push(ja.judges.length === 0
      ? 'No per-judge runs stored for this prompt version yet, so there is no judge-vs-judge agreement to report.'
      : ja.judges.length === 1
        ? `Single judge (${cell(ja.judges[0])}): no judge-vs-judge agreement to report.`
        : 'No sessions scored by more than one judge yet.');
  } else {
    L.push(`${ja.judges.length} judge models over ${ja.session_count} scored sessions (all time, this prompt version).`);
    L.push('');
    L.push(...table(
      ['Judge A', 'Judge B', 'Shared sessions', 'Weighted kappa', 'Band', 'Major disagreement'],
      ja.pairs.map(p => [p.judge_a, p.judge_b, p.n, f2(p.overall_kappa), kappaBand(p.overall_kappa), p.major_disagreement_pct === null ? '-' : `${p.major_disagreement_pct.toFixed(0)}%`]),
    ));
    if (ja.high_disagreement_count > 0) {
      L.push('');
      L.push(`${ja.high_disagreement_count} session${ja.high_disagreement_count === 1 ? '' : 's'} flagged for human review because the judges disagreed by 2 or more points.`);
    }
  }
  L.push('');

  // 3. Drift
  L.push('## 3. Drift alerts');
  L.push('');
  L.push(`Opened this week: **${d.drift.opened_in_window}**. Acknowledged this week: **${d.drift.acknowledged_in_window}**. ` +
    `Still open at week end: **${d.drift.open_at_end}**. Paged on-call: ${d.drift.paged_in_window}.`);
  L.push('');

  // 4. Harness
  L.push('## 4. Red-team and simulation harness');
  L.push('');
  if (d.harness.suites.length === 0) {
    L.push('No harness runs this week.');
  } else {
    L.push(...table(
      ['Suite', 'Runs', 'Scenarios', 'Passed', 'Pass rate', 'Last run'],
      d.harness.suites.map(s => [s.suite, s.runs, s.scenarios, s.passed, pct(s.pass_rate), day(s.last_run_at)]),
    ));
  }
  if (d.harness.nightly_diff.length > 0) {
    L.push('');
    L.push('**Nightly diff** (latest nightly run this week against the run before it):');
    L.push('');
    L.push(...table(
      ['Suite', 'Latest', 'Previous', 'Pass-rate change'],
      d.harness.nightly_diff.map(x => [
        x.suite,
        `${x.latest.pass_count}/${x.latest.scenario_count} on ${day(x.latest.started_at)}`,
        x.previous ? `${x.previous.pass_count}/${x.previous.scenario_count} on ${day(x.previous.started_at)}` : 'none',
        x.pass_rate_delta === null ? '-' : `${x.pass_rate_delta >= 0 ? '+' : ''}${Math.round(x.pass_rate_delta * 100)} pts`,
      ]),
    ));
  }
  L.push('');

  // 5. Crisis
  L.push('## 5. Crisis events');
  L.push('');
  if (d.crisis.total === 0) {
    L.push('No crisis events this week.');
  } else {
    L.push(`**${d.crisis.total}** crisis event${d.crisis.total === 1 ? '' : 's'}; ${d.crisis.pages_sent} on-call page${d.crisis.pages_sent === 1 ? '' : 's'} sent.`);
    L.push('');
    L.push(...table(['Severity', 'Events'], d.crisis.events_by_severity.map(x => [x.severity, x.n])));
    L.push('');
    L.push(...table(['Event type', 'Events'], d.crisis.events_by_type.map(x => [x.event_type, x.n])));
  }
  L.push('');
  if (d.crisis.adjudication === null) {
    L.push('Adjudication: adjudication not yet enabled.');
  } else if (d.crisis.adjudication.length === 0) {
    L.push('Adjudication: no events to adjudicate.');
  } else {
    L.push('Adjudication outcomes:');
    L.push('');
    L.push(...table(['Outcome', 'Events'], d.crisis.adjudication.map(x => [x.outcome, x.n])));
  }
  L.push('');

  // 6. Calibration
  L.push('## 6. Human-judge calibration');
  L.push('');
  const c = d.calibration;
  L.push(`${c.pair_count} paired human/judge rating${c.pair_count === 1 ? '' : 's'} over ${c.session_count} session${c.session_count === 1 ? '' : 's'} ` +
    `(${c.meets_pair_rule ? 'meets' : 'below'} the ${c.min_pairs}-rating rule). Overall weighted kappa: ${f2(c.overall_kappa)} (${kappaBand(c.overall_kappa)}). ` +
    `Target: >= ${c.target_kappa} on every dimension - ${c.meets_kappa_rule ? 'met' : 'not yet met'}.`);
  L.push('');
  L.push(...table(
    ['Dimension', 'Pairs', 'Weighted kappa', 'Band'],
    c.dimensions.map(x => [x.label, x.n, f2(x.kappa), x.band]),
  ));
  L.push('');

  // 7. Gaps
  L.push('## 7. Open gaps');
  L.push('');
  for (const g of d.gaps) L.push(`- ${g.open ? 'OPEN' : 'closed'} - **${cell(g.label)}**: ${cell(g.detail)}`);
  L.push('');

  L.push('---');
  L.push('');
  L.push(`Generated ${d.meta.generated_at} from build ${d.meta.git_sha}. This digest is produced by the study software; it reports what the database holds and does not interpret it.`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildWeeklyDigest(input: BuildWeeklyDigestInput): Promise<WeeklyDigest> {
  if (!isValidWeekEnding(input.weekEnding)) throw new Error(`weekEnding must be YYYY-MM-DD, got ${String(input.weekEnding)}`);
  const { from, to } = weekWindow(input.weekEnding);
  const [irbOrgId, org, config] = await Promise.all([getIrbStudyOrgId(), getOrganizationById(input.orgId), getSystemConfig()]);
  const isIrbOrg = irbOrgId !== null && irbOrgId === input.orgId;
  const w: IrbWindow = { from, to, orgId: input.orgId, includeUnattributed: isIrbOrg };
  const evalsConfig = (config.evals ?? {}) as Record<string, unknown>;
  const promptVersion = EVAL_PROMPT_VERSION;

  const [sessionsEvaluated, scoreRows, safety, monitoring, nightlyPairs, adjudication, calibrationReport, judgeAgreement] = await Promise.all([
    getSessionsEvaluatedCount(w, promptVersion),
    getWeeklyEvalScores(w, input.weekEnding, TREND_PRIOR_WEEKS + 1, promptVersion),
    getIrbSafetyCounts(w),
    getIrbMonitoringCounts(w),
    getNightlyRunPairs(w),
    getCrisisAdjudicationCounts(w),
    computeCalibrationReport(promptVersion),
    computeJudgeAgreementReport(promptVersion),
  ]);

  const data: WeeklyDigestData = {
    meta: {
      generated_at: input.generatedAt ?? new Date().toISOString(),
      git_sha: gitSha(),
      week_ending: input.weekEnding,
      period: { from, to },
      organization: { id: input.orgId, name: org?.name ?? null, is_irb_study_org: isIrbOrg },
      prompt_version: promptVersion,
      sources: SOURCES,
    },
    sessions_evaluated: sessionsEvaluated,
    trend: computeTrend(scoreRows, input.weekEnding),
    judge_agreement: summarizeJudgeAgreement(judgeAgreement),
    drift: monitoring.drift_alerts,
    harness: {
      suites: monitoring.harness_runs.map(s => ({ ...s, last_run_at: s.last_run_at ? new Date(s.last_run_at).toISOString() : null })),
      nightly_diff: nightlyPairs.map(nightlyDiffOf),
    },
    crisis: summarizeCrisis(safety, adjudication),
    calibration: summarizeCalibration(calibrationReport),
    gaps: [],
  };
  data.gaps = computeGaps(evalsConfig, data.calibration, adjudication !== null);
  return { markdown: renderWeeklyDigestMarkdown(data), data };
}

export function summarizeJudgeAgreement(r: JudgeAgreementReport): WeeklyDigestData['judge_agreement'] {
  return {
    judges: r.judges,
    session_count: r.session_count,
    pairs: r.pairs.map(p => {
      const majors = p.dimensions.map(x => x.major_disagreement_pct).filter((x): x is number => x !== null);
      return {
        judge_a: p.judge_a,
        judge_b: p.judge_b,
        n: p.n,
        overall_kappa: p.overall_kappa,
        major_disagreement_pct: majors.length ? majors.reduce((s, x) => s + x, 0) / majors.length : null,
      };
    }),
    high_disagreement_count: r.high_disagreement.length,
  };
}

export function summarizeCrisis(
  safety: Awaited<ReturnType<typeof getIrbSafetyCounts>>,
  adjudication: { outcome: string; n: number }[] | null,
): WeeklyDigestData['crisis'] {
  const bySeverity = new Map<string, number>();
  const byType = new Map<string, number>();
  let total = 0;
  for (const e of safety.crisis_events) {
    bySeverity.set(e.severity, (bySeverity.get(e.severity) ?? 0) + e.n);
    byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + e.n);
    total += e.n;
  }
  const order = ['critical', 'high', 'medium', 'low', 'unknown'];
  return {
    events_by_severity: [...bySeverity].map(([severity, n]) => ({ severity, n }))
      .sort((a, b) => (order.indexOf(a.severity) + 99) % 99 - (order.indexOf(b.severity) + 99) % 99 || a.severity.localeCompare(b.severity)),
    events_by_type: [...byType].map(([event_type, n]) => ({ event_type, n })).sort((a, b) => a.event_type.localeCompare(b.event_type)),
    total,
    pages_sent: safety.pages_sent,
    adjudication,
  };
}

export function summarizeCalibration(r: CalibrationReport): WeeklyDigestData['calibration'] {
  const dimensions = r.dimensions.map(x => ({
    dimension: x.dimension,
    label: DIMENSION_LABELS[x.dimension] ?? x.dimension,
    n: x.n,
    kappa: x.kappa,
    band: kappaBand(x.kappa),
  }));
  return {
    pair_count: r.pair_count,
    session_count: r.session_count,
    min_pairs: MIN_PAIRED_RATINGS,
    target_kappa: TARGET_KAPPA,
    overall_kappa: r.overall_kappa,
    dimensions,
    meets_pair_rule: r.pair_count >= MIN_PAIRED_RATINGS,
    meets_kappa_rule: dimensions.length > 0 && dimensions.every(x => x.kappa !== null && x.kappa >= TARGET_KAPPA),
  };
}

/** Build and archive a digest. `generatedBy` is 'scheduler' or the admin
 *  username; it is stored for accountability and never rendered. */
export async function generateAndStoreWeeklyDigest(input: BuildWeeklyDigestInput & { generatedBy: string }): Promise<WeeklyDigestRow> {
  const digest = await buildWeeklyDigest(input);
  return insertWeeklyDigest({
    orgId: input.orgId,
    weekEnding: input.weekEnding,
    markdown: digest.markdown,
    data: digest.data as unknown as Record<string, unknown>,
    generatedBy: input.generatedBy,
    generatedAt: digest.data.meta.generated_at,
  });
}

// ---------------------------------------------------------------------------
// Weekly schedule (system_config: evals.digest_schedule)
// ---------------------------------------------------------------------------

export interface DigestSchedule {
  enabled: boolean;
  /** 0 = Sunday ... 6 = Saturday (UTC). Default Monday. */
  weekday: number;
  /** UTC hour 0-23. Default 06. */
  hour_utc: number;
}

export const DEFAULT_DIGEST_SCHEDULE: DigestSchedule = { enabled: false, weekday: 1, hour_utc: 6 };

export function normalizeDigestSchedule(raw: unknown): DigestSchedule {
  const r = (raw ?? {}) as Partial<DigestSchedule>;
  const int = (v: unknown, lo: number, hi: number, dflt: number) =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : dflt;
  return {
    enabled: r.enabled === true,
    weekday: int(r.weekday, 0, 6, DEFAULT_DIGEST_SCHEDULE.weekday),
    hour_utc: int(r.hour_utc, 0, 23, DEFAULT_DIGEST_SCHEDULE.hour_utc),
  };
}

export async function getDigestSchedule(): Promise<DigestSchedule> {
  const config = await getSystemConfig();
  const evals = (config.evals ?? {}) as { digest_schedule?: unknown };
  return normalizeDigestSchedule(evals.digest_schedule);
}

/** Persist under system_config.evals.digest_schedule, merging with the rest of
 *  the evals config (same update-then-insert dance as setHarnessSchedule). */
export async function setDigestSchedule(raw: unknown, updatedBy: string): Promise<DigestSchedule> {
  const schedule = normalizeDigestSchedule(raw);
  const { rows } = await pool.query<{ config_value: Record<string, unknown> }>(
    `SELECT config_value FROM system_config WHERE config_key = 'evals' LIMIT 1`,
  );
  const merged = { ...(rows[0]?.config_value ?? {}), digest_schedule: schedule };
  if (rows.length > 0) {
    await pool.query(
      `UPDATE system_config SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
       WHERE config_key = 'evals'`,
      [JSON.stringify(merged), updatedBy],
    );
  } else {
    await pool.query(
      `INSERT INTO system_config (config_key, config_value, description, updated_by)
       VALUES ('evals', $1, 'Eval-system settings (drift monitoring, harness schedule, digest schedule)', $2)`,
      [JSON.stringify(merged), updatedBy],
    );
  }
  invalidateConfigCache();
  return schedule;
}

/** Debounce: a scheduled digest counts as "this week's" for 6 days. */
const DIGEST_DEBOUNCE_MS = 6 * 24 * 60 * 60 * 1000;

/** Pure decision: fire when enabled, the UTC weekday and hour match, and no
 *  scheduler-generated digest exists from the last 6 days (restart-safe via
 *  the weekly_digests table). */
export function digestDue(schedule: DigestSchedule, now: Date, lastScheduledAt: Date | null): boolean {
  if (!schedule.enabled) return false;
  if (now.getUTCDay() !== schedule.weekday || now.getUTCHours() !== schedule.hour_utc) return false;
  if (lastScheduledAt && now.getTime() - lastScheduledAt.getTime() < DIGEST_DEBOUNCE_MS) return false;
  return true;
}

const SCHEDULER_TICK_MS = 5 * 60 * 1000;
let schedulerTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/** One scheduler tick: generate the previous week's digest for the irb-study
 *  org when due. Exported for tests; never throws. */
export async function digestSchedulerTick(now: Date = new Date()): Promise<boolean> {
  if (tickInFlight) return false;
  tickInFlight = true;
  try {
    const schedule = await getDigestSchedule();
    if (!schedule.enabled) return false;
    const orgId = await getIrbStudyOrgId();
    if (orgId === null) return false;
    const last = await getLastScheduledDigestAt(orgId);
    if (!digestDue(schedule, now, last)) return false;
    const weekEnding = defaultWeekEnding(now);
    log.info(`weekly digest due (org=${orgId}, week ending ${weekEnding})`);
    const row = await generateAndStoreWeeklyDigest({ weekEnding, orgId, generatedBy: 'scheduler' });
    log.info(`weekly digest #${row.id} stored for week ending ${weekEnding}`);
    return true;
  } catch (err) {
    log.error({ err }, 'weekly digest scheduler tick failed');
    return false;
  } finally {
    tickInFlight = false;
  }
}

/** Start the in-process weekly scheduler (no-op when already started). */
export function startWeeklyDigestScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => { void digestSchedulerTick(); }, SCHEDULER_TICK_MS);
  schedulerTimer.unref?.();
  log.info('weekly digest scheduler started (5min tick)');
}
