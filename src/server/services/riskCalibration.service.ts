// Risk-score calibration harness (eval program WP3, ai-therapist-175, gap G3).
//
// Joins risk_score_history x crisis_events x crisis_event_adjudications per
// scored message, derives a binary label from the human verdicts, and grades
// every signal layer the pipeline logs (keyword tier, LLM assessor, each
// moderation category, the moderation composite, the trajectory bonus, and
// the composite score the pipeline acted on) against that label: precision /
// recall / F1 on a fixed threshold grid, performance at the live bands
// (25 / 50 / 75), a layer-agreement (kappa) matrix, and a miss-rate estimate
// from a stratified sample of UNFLAGGED messages re-scored offline with the
// same assessor (assessRiskOffline, redacted text only, hard USD cap).
//
// Label rule (reportable, see LABEL_RULE):
//   - a scored message that raised a crisis event:
//       all adjudicators say confirmed      -> positive
//       all adjudicators say false_positive -> negative
//       unclear, or adjudicators disagree   -> excluded
//       no adjudication yet                 -> excluded (unlabelled)
//   - a scored message that raised no event: negative ONLY when the run's
//     `unflagged_as_negative` param is on (the default), and the report then
//     states that assumption next to the adjudication coverage counts. The
//     miss-rate sample is the check on that assumption.
//
// Everything in the stored report is an aggregate (counts, rates, kappas,
// thresholds) plus the message ids of the miss-rate sample; no text, no
// participant identifiers. Recommendations are ADVISORY ONLY: nothing here
// writes to the live pipeline's thresholds, which stay a human decision.
import { gitSha } from '../utils/gitSha.js';
import { createLogger } from '../utils/logger.js';
import { getIrbStudyOrgId } from '../db/organizations.queries.js';
import type { IrbWindow } from '../db/irbPacket.queries.js';
import {
  getScoredMessages,
  getAdjudicationCoverage,
  getUnflaggedCandidates,
  getRedactedMessageContext,
  insertRiskCalibrationRun,
  UNFLAGGED_MAX_SCORE,
  type ScoredMessageRow,
  type AdjudicationCoverage,
  type UnflaggedCandidate,
  type RiskCalibrationRunRow,
} from '../db/riskCalibration.queries.js';
import { assessRiskOffline } from './crisisDetection.service.js';

const log = createLogger('riskCalibration');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold grid every layer is scored on (0..100 step 5). */
export const THRESHOLD_GRID: readonly number[] = Array.from({ length: 21 }, (_, i) => i * 5);

/** The live pipeline's severity bands (crisisDetection severityForScore). */
export const CURRENT_BANDS = { low: 25, medium: 50, high: 75 } as const;

/** Binary cut used for the layer-agreement matrix: "this layer would flag". */
export const AGREEMENT_FLAG_THRESHOLD = 50;

/** Fewest labelled positives AND negatives before any P/R/F1 is reported. */
export const MIN_LABELS_PER_CLASS = 5;

/** Hard cap on live assessor spend for one run's miss-rate sample. */
export const MISS_RATE_BUDGET_USD = 0.5;
export const DEFAULT_SAMPLE_SIZE = 50;
export const MAX_SAMPLE_SIZE = 500;
/** Default lookback for a run. */
export const DEFAULT_SINCE_DAYS = 365;

/** USD per 1M tokens for the assessor (hand-maintained estimate; invoices
 *  are the source of truth - mirrors costTracking.queries.ts). */
const ASSESSOR_RATES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
};
const DEFAULT_RATE = { input: 0.5, output: 1.5 };

export const LABEL_RULE =
  'positive = crisis event unanimously adjudicated confirmed; negative = unanimously false_positive; ' +
  'unclear, disputed or unadjudicated events are excluded; scored messages that raised no event count as ' +
  'negative only when unflagged_as_negative is on (stated in coverage).';

export type LayerKey =
  | 'composite'
  | 'keyword'
  | 'llm'
  | 'moderation_self_harm'
  | 'moderation_self_harm_intent'
  | 'moderation_self_harm_instructions'
  | 'moderation_composite'
  | 'trajectory';

export interface LayerDef {
  key: LayerKey;
  label: string;
  /** How the raw signal maps onto the 0..100 grid. */
  scale: string;
}

export const LAYERS: readonly LayerDef[] = [
  { key: 'composite', label: 'Composite (acted on)', scale: '0..100 as logged' },
  { key: 'keyword', label: 'Keyword tier', scale: '0..100 tier score (15 / 50 / 75)' },
  { key: 'llm', label: 'LLM assessor', scale: '0..100 as returned; rows the LLM never saw are omitted' },
  { key: 'moderation_self_harm', label: 'Moderation: self-harm', scale: 'category probability x 100' },
  { key: 'moderation_self_harm_intent', label: 'Moderation: self-harm intent', scale: 'category probability x 100' },
  {
    key: 'moderation_self_harm_instructions',
    label: 'Moderation: self-harm instructions',
    scale: 'category probability x 100',
  },
  {
    key: 'moderation_composite',
    label: 'Moderation composite',
    scale: '0..100 pipeline composite (moderationRiskScore)',
  },
  { key: 'trajectory', label: 'Trajectory bonus', scale: '0..20 bonus as logged' },
];

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type Label = 'positive' | 'negative' | 'excluded';

export interface LabeledSample {
  history_id: number;
  label: Label;
  reason:
    | 'confirmed'
    | 'false_positive'
    | 'unclear'
    | 'disputed'
    | 'unadjudicated'
    | 'no_event_assumed_negative'
    | 'no_event_unlabelled';
  signals: Record<LayerKey, number | null>;
}

/** Collapse one event's verdicts to a label. */
export function labelForVerdicts(
  verdicts: readonly string[],
  hasEvent: boolean,
  unflaggedAsNegative: boolean,
): Pick<LabeledSample, 'label' | 'reason'> {
  if (!hasEvent) {
    return unflaggedAsNegative
      ? { label: 'negative', reason: 'no_event_assumed_negative' }
      : { label: 'excluded', reason: 'no_event_unlabelled' };
  }
  if (verdicts.length === 0) return { label: 'excluded', reason: 'unadjudicated' };
  const distinct = new Set(verdicts);
  if (distinct.size > 1) return { label: 'excluded', reason: 'disputed' };
  const only = verdicts[0];
  if (only === 'confirmed') return { label: 'positive', reason: 'confirmed' };
  if (only === 'false_positive') return { label: 'negative', reason: 'false_positive' };
  return { label: 'excluded', reason: 'unclear' };
}

const pct = (p: number | null): number | null => (p === null ? null : Math.round(p * 10000) / 100);

export function signalsFor(row: ScoredMessageRow): Record<LayerKey, number | null> {
  return {
    composite: row.risk_score,
    keyword: row.keyword_score,
    llm: row.llm_score,
    moderation_self_harm: pct(row.moderation_self_harm),
    moderation_self_harm_intent: pct(row.moderation_self_harm_intent),
    moderation_self_harm_instructions: pct(row.moderation_self_harm_instructions),
    moderation_composite: row.moderation_score,
    trajectory: row.trajectory_score,
  };
}

export function deriveLabels(rows: readonly ScoredMessageRow[], unflaggedAsNegative: boolean): LabeledSample[] {
  return rows.map((row) => ({
    history_id: row.history_id,
    ...labelForVerdicts(row.verdicts, row.crisis_event_id !== null, unflaggedAsNegative),
    signals: signalsFor(row),
  }));
}

// ---------------------------------------------------------------------------
// Pure metric math
// ---------------------------------------------------------------------------

export interface ScoredPair {
  score: number;
  positive: boolean;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface MetricPoint extends Confusion {
  threshold: number;
  /** null when no predicted positives (precision undefined). */
  precision: number | null;
  /** null when no actual positives. */
  recall: number | null;
  /** null when precision or recall is undefined. */
  f1: number | null;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export function confusionAt(pairs: readonly ScoredPair[], threshold: number): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const p of pairs) {
    const predicted = p.score >= threshold;
    if (predicted && p.positive) c.tp++;
    else if (predicted && !p.positive) c.fp++;
    else if (!predicted && p.positive) c.fn++;
    else c.tn++;
  }
  return c;
}

export function metricsFromConfusion(threshold: number, c: Confusion): MetricPoint {
  const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision !== null && recall !== null
        ? 0
        : null;
  return {
    threshold,
    ...c,
    precision: precision === null ? null : round4(precision),
    recall: recall === null ? null : round4(recall),
    f1: f1 === null ? null : round4(f1),
  };
}

/** P/R/F1 at every grid threshold (score >= threshold predicts positive). */
export function computeMetricsGrid(
  pairs: readonly ScoredPair[],
  grid: readonly number[] = THRESHOLD_GRID,
): MetricPoint[] {
  return grid.map((t) => metricsFromConfusion(t, confusionAt(pairs, t)));
}

export interface BandPerformance {
  low: MetricPoint;
  medium: MetricPoint;
  high: MetricPoint;
}

/** Performance at the live bands, "flag at >= band". */
export function computeBandPerformance(pairs: readonly ScoredPair[]): BandPerformance {
  return {
    low: metricsFromConfusion(CURRENT_BANDS.low, confusionAt(pairs, CURRENT_BANDS.low)),
    medium: metricsFromConfusion(CURRENT_BANDS.medium, confusionAt(pairs, CURRENT_BANDS.medium)),
    high: metricsFromConfusion(CURRENT_BANDS.high, confusionAt(pairs, CURRENT_BANDS.high)),
  };
}

/**
 * Cohen's kappa between two binary raters over the same items; null when
 * fewer than 2 items or when chance agreement is 1 (both constant), since
 * kappa is undefined there.
 */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let both = 0,
    aOnly = 0,
    bOnly = 0,
    neither = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] && b[i]) both++;
    else if (a[i]) aOnly++;
    else if (b[i]) bOnly++;
    else neither++;
  }
  const po = (both + neither) / n;
  const pa = (both + aOnly) / n;
  const pb = (both + bOnly) / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe >= 1) return null;
  return round4((po - pe) / (1 - pe));
}

export interface AgreementMatrix {
  layers: LayerKey[];
  flag_threshold: number;
  /** kappa[i][j]; null on the diagonal is replaced by 1, null elsewhere = undefined. */
  kappa: Array<Array<number | null>>;
  /** Raw agreement fraction. */
  agreement: Array<Array<number | null>>;
  /** Items both layers had a value for. */
  n: number[][];
}

/**
 * Pairwise kappa between layers, each binarised at `flagThreshold`, over the
 * messages where BOTH layers have a value. Needs no labels, so it is reported
 * even when the labelled sample is too small for P/R/F1.
 */
export function computeAgreementMatrix(
  samples: readonly Pick<LabeledSample, 'signals'>[],
  layers: readonly LayerKey[] = LAYERS.map((l) => l.key),
  flagThreshold = AGREEMENT_FLAG_THRESHOLD,
): AgreementMatrix {
  const k = layers.length;
  const kappa: Array<Array<number | null>> = [];
  const agreement: Array<Array<number | null>> = [];
  const n: number[][] = [];
  for (let i = 0; i < k; i++) {
    kappa.push([]);
    agreement.push([]);
    n.push([]);
    for (let j = 0; j < k; j++) {
      const a: boolean[] = [];
      const b: boolean[] = [];
      for (const s of samples) {
        const x = s.signals[layers[i]];
        const y = s.signals[layers[j]];
        if (x === null || y === null) continue;
        a.push(x >= flagThreshold);
        b.push(y >= flagThreshold);
      }
      n[i].push(a.length);
      if (i === j) {
        kappa[i].push(a.length > 0 ? 1 : null);
        agreement[i].push(a.length > 0 ? 1 : null);
        continue;
      }
      kappa[i].push(cohenKappa(a, b));
      agreement[i].push(a.length > 0 ? round4(a.filter((v, idx) => v === b[idx]).length / a.length) : null);
    }
  }
  return { layers: [...layers], flag_threshold: flagThreshold, kappa, agreement, n };
}

export interface ThresholdRecommendation {
  layer: LayerKey;
  /** Live band the layer's flag currently corresponds to (medium). */
  current: number;
  /** F1-maximising grid threshold; ties go to the one nearest `current`. */
  recommended: number | null;
  f1_at_current: number | null;
  f1_at_recommended: number | null;
  n: number;
}

export function recommendThreshold(
  layer: LayerKey,
  grid: readonly MetricPoint[],
  current: number,
  n: number,
): ThresholdRecommendation {
  let best: MetricPoint | null = null;
  for (const p of grid) {
    if (p.f1 === null) continue;
    if (
      best === null ||
      p.f1 > best.f1! ||
      (p.f1 === best.f1 && Math.abs(p.threshold - current) < Math.abs(best.threshold - current))
    )
      best = p;
  }
  const atCurrent = grid.find((p) => p.threshold === current)?.f1 ?? null;
  return {
    layer,
    current,
    recommended: best?.threshold ?? null,
    f1_at_current: atCurrent,
    f1_at_recommended: best?.f1 ?? null,
    n,
  };
}

// ---------------------------------------------------------------------------
// Seeded stratified sampler
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, deterministic PRNG for reproducible samples. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Proportional stratified sample (largest-remainder allocation, at least one
 * per non-empty stratum when size >= number of strata), shuffled per stratum with
 * the seeded PRNG. Same candidates + same seed + same size = same sample.
 * Candidates are taken in the order given, so callers must order them
 * deterministically (the queries order by message_id).
 */
export function stratifiedSample<T extends { stratum: string }>(
  candidates: readonly T[],
  size: number,
  seed: number,
): T[] {
  if (size <= 0 || candidates.length === 0) return [];
  const byStratum = new Map<string, T[]>();
  for (const c of candidates) {
    const list = byStratum.get(c.stratum);
    if (list) list.push(c);
    else byStratum.set(c.stratum, [c]);
  }
  const strata = Array.from(byStratum.keys()).sort();
  const total = candidates.length;
  const want = Math.min(size, total);

  // Largest-remainder allocation, capped at the stratum's size, with a floor
  // of one per stratum whenever the sample is big enough to afford it (small
  // strata are exactly where a miss-rate check wants coverage).
  const sizeOf = (i: number) => byStratum.get(strata[i])!.length;
  const floor = want >= strata.length ? 1 : 0;
  const quota = strata.map((_, i) => (sizeOf(i) / total) * want);
  const alloc = quota.map((q, i) => Math.min(Math.max(floor, Math.floor(q)), sizeOf(i)));
  let remaining = want - alloc.reduce((a, b) => a + b, 0);
  // The floor can overshoot: take back from the strata furthest above quota.
  while (remaining < 0) {
    const i = strata
      .map((_, k) => k)
      .filter((k) => alloc[k] > floor)
      .sort((a, b) => alloc[b] - quota[b] - (alloc[a] - quota[a]) || a - b)[0];
    alloc[i]--;
    remaining++;
  }
  const order = strata.map((_, i) => i).sort((i, j) => quota[j] - alloc[j] - (quota[i] - alloc[i]) || i - j);
  for (const i of order) {
    if (remaining <= 0) break;
    if (alloc[i] < sizeOf(i)) {
      alloc[i]++;
      remaining--;
    }
  }
  // Any leftover (strata exhausted) goes to whoever still has room.
  for (let i = 0; remaining > 0 && i < strata.length; i++) {
    const room = byStratum.get(strata[i])!.length - alloc[i];
    const take = Math.min(room, remaining);
    alloc[i] += take;
    remaining -= take;
  }

  const rng = mulberry32(seed);
  const out: T[] = [];
  strata.forEach((s, i) => {
    const pool = [...byStratum.get(s)!];
    for (let k = pool.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    out.push(...pool.slice(0, alloc[i]));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface RiskCalibrationParams {
  /** ISO lower bound (inclusive). */
  since: string;
  /** ISO upper bound (inclusive). */
  until: string;
  sample_size: number;
  seed: number;
  unflagged_as_negative: boolean;
  dry_run: boolean;
  budget_usd: number;
}

export interface LayerReport {
  key: LayerKey;
  label: string;
  scale: string;
  /** Labelled messages with a value for this layer. */
  n: number;
  positives: number;
  grid: MetricPoint[];
  bands: BandPerformance | null;
}

export interface MissRateStratum {
  stratum: string;
  candidates: number;
  sampled: number;
  scored: number;
  ge_50: number;
  ge_75: number;
}

export interface MissRateReport {
  /** Unflagged messages eligible for sampling (never raised an event, composite <= UNFLAGGED_MAX_SCORE or unscored). */
  candidates: number;
  unflagged_max_score: number;
  requested: number;
  sampled: number;
  scored: number;
  failed: number;
  /** Stopped early because the budget cap was reached. */
  budget_exhausted: boolean;
  ge_50: number;
  ge_75: number;
  /** scored > 0 ? ge_50 / scored : null */
  fraction_ge_50: number | null;
  fraction_ge_75: number | null;
  spend_usd: number;
  budget_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  assessor_model: string | null;
  by_stratum: MissRateStratum[];
  /** Ids of the sampled messages (so a researcher can open them); no text. */
  sampled_message_ids: number[];
  dry_run: boolean;
  note: string;
}

export interface RiskCalibrationReport {
  meta: { generated_at: string; git_sha: string; org_id: number; window: { from: string; to: string } };
  label_rule: string;
  labels: {
    scored_messages: number;
    with_event: number;
    positives: number;
    negatives: number;
    negatives_from_false_positive: number;
    negatives_assumed_unflagged: number;
    excluded_unclear: number;
    excluded_disputed: number;
    excluded_unadjudicated: number;
    excluded_no_event: number;
    unflagged_as_negative: boolean;
    min_labels_per_class: number;
    insufficient_labels: boolean;
    coverage: AdjudicationCoverage;
  };
  current_bands: typeof CURRENT_BANDS;
  layers: LayerReport[];
  agreement: AgreementMatrix;
  recommendations: ThresholdRecommendation[];
  advisory: true;
  miss_rate: MissRateReport | null;
}

// ---------------------------------------------------------------------------
// Miss-rate estimate
// ---------------------------------------------------------------------------

export interface OfflineScorer {
  (
    latest: string,
    history: Array<{ role: string; content_redacted: string }>,
  ): Promise<{
    risk_score: number;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
  }>;
}

export function assessorCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const rate = ASSESSOR_RATES[model] ?? DEFAULT_RATE;
  return (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000;
}

const MISS_RATE_NOTE =
  'Re-scored offline from content_redacted (redaction placeholders stand in for names and places), ' +
  'with up to 10 preceding redacted turns as context and no trajectory bonus; the live score may differ.';

/**
 * Re-score the sampled unflagged messages with the offline assessor, stopping
 * when the budget cap would be exceeded. `scorer` and `contextFor` are
 * injectable for tests; production uses assessRiskOffline + the redacted
 * context query.
 */
export async function estimateMissRate(
  candidates: readonly UnflaggedCandidate[],
  params: Pick<RiskCalibrationParams, 'sample_size' | 'seed' | 'dry_run' | 'budget_usd'>,
  deps: {
    scorer?: OfflineScorer;
    contextFor?: typeof getRedactedMessageContext;
    concurrency?: number;
  } = {},
): Promise<MissRateReport> {
  const sample = stratifiedSample(candidates, params.sample_size, params.seed);
  const byStratum = new Map<string, MissRateStratum>();
  for (const c of candidates) {
    const s = byStratum.get(c.stratum) ?? {
      stratum: c.stratum,
      candidates: 0,
      sampled: 0,
      scored: 0,
      ge_50: 0,
      ge_75: 0,
    };
    s.candidates++;
    byStratum.set(c.stratum, s);
  }
  for (const c of sample) byStratum.get(c.stratum)!.sampled++;

  const report: MissRateReport = {
    candidates: candidates.length,
    unflagged_max_score: UNFLAGGED_MAX_SCORE,
    requested: params.sample_size,
    sampled: sample.length,
    scored: 0,
    failed: 0,
    budget_exhausted: false,
    ge_50: 0,
    ge_75: 0,
    fraction_ge_50: null,
    fraction_ge_75: null,
    spend_usd: 0,
    budget_usd: params.budget_usd,
    prompt_tokens: 0,
    completion_tokens: 0,
    assessor_model: null,
    by_stratum: [],
    sampled_message_ids: sample.map((c) => c.message_id),
    dry_run: params.dry_run,
    note: MISS_RATE_NOTE,
  };
  if (params.dry_run || sample.length === 0) {
    report.by_stratum = Array.from(byStratum.values()).sort((a, b) => a.stratum.localeCompare(b.stratum));
    return report;
  }

  const scorer: OfflineScorer = deps.scorer ?? assessRiskOffline;
  const contextFor = deps.contextFor ?? getRedactedMessageContext;
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  // Conservative per-call estimate until real usage arrives (about 2.5k
  // prompt tokens + 150 completion tokens on gpt-4o-mini is ~$0.0005).
  let perCallEstimate = 0.002;
  let next = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    while (!stop) {
      const idx = next++;
      if (idx >= sample.length) return;
      if (report.spend_usd + perCallEstimate > params.budget_usd) {
        report.budget_exhausted = true;
        stop = true;
        return;
      }
      const item = sample[idx];
      const stratum = byStratum.get(item.stratum)!;
      try {
        const ctx = await contextFor(item.message_id);
        if (!ctx) {
          report.failed++;
          continue;
        }
        const result = await scorer(ctx.latest, ctx.history);
        const cost = assessorCostUsd(result.model, result.prompt_tokens, result.completion_tokens);
        report.spend_usd += cost;
        report.prompt_tokens += result.prompt_tokens;
        report.completion_tokens += result.completion_tokens;
        report.assessor_model = result.model;
        if (cost > 0) perCallEstimate = Math.max(cost, report.spend_usd / Math.max(1, report.scored + 1));
        report.scored++;
        stratum.scored++;
        if (result.risk_score >= 50) {
          report.ge_50++;
          stratum.ge_50++;
        }
        if (result.risk_score >= 75) {
          report.ge_75++;
          stratum.ge_75++;
        }
      } catch (err) {
        report.failed++;
        log.error({ err }, `[riskCalibration] offline re-score failed for message ${item.message_id}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, worker));

  report.spend_usd = Math.round(report.spend_usd * 1_000_000) / 1_000_000;
  report.fraction_ge_50 = report.scored > 0 ? round4(report.ge_50 / report.scored) : null;
  report.fraction_ge_75 = report.scored > 0 ? round4(report.ge_75 / report.scored) : null;
  report.by_stratum = Array.from(byStratum.values()).sort((a, b) => a.stratum.localeCompare(b.stratum));
  return report;
}

// ---------------------------------------------------------------------------
// Report assembly (pure given the rows) and the full build
// ---------------------------------------------------------------------------

export function assembleLabelReport(
  rows: readonly ScoredMessageRow[],
  coverage: AdjudicationCoverage,
  unflaggedAsNegative: boolean,
): Pick<RiskCalibrationReport, 'labels' | 'layers' | 'agreement' | 'recommendations'> & { samples: LabeledSample[] } {
  const samples = deriveLabels(rows, unflaggedAsNegative);
  const count = (pred: (s: LabeledSample) => boolean) => samples.filter(pred).length;
  const positives = count((s) => s.label === 'positive');
  const negatives = count((s) => s.label === 'negative');
  const insufficient = positives < MIN_LABELS_PER_CLASS || negatives < MIN_LABELS_PER_CLASS;

  const labels: RiskCalibrationReport['labels'] = {
    scored_messages: samples.length,
    with_event: rows.filter((r) => r.crisis_event_id !== null).length,
    positives,
    negatives,
    negatives_from_false_positive: count((s) => s.reason === 'false_positive'),
    negatives_assumed_unflagged: count((s) => s.reason === 'no_event_assumed_negative'),
    excluded_unclear: count((s) => s.reason === 'unclear'),
    excluded_disputed: count((s) => s.reason === 'disputed'),
    excluded_unadjudicated: count((s) => s.reason === 'unadjudicated'),
    excluded_no_event: count((s) => s.reason === 'no_event_unlabelled'),
    unflagged_as_negative: unflaggedAsNegative,
    min_labels_per_class: MIN_LABELS_PER_CLASS,
    insufficient_labels: insufficient,
    coverage,
  };

  const labelled = samples.filter((s) => s.label !== 'excluded');
  const layers: LayerReport[] = LAYERS.map((def) => {
    const pairs: ScoredPair[] = [];
    for (const s of labelled) {
      const v = s.signals[def.key];
      if (v === null) continue;
      pairs.push({ score: v, positive: s.label === 'positive' });
    }
    const layerPositives = pairs.filter((p) => p.positive).length;
    const layerNegatives = pairs.length - layerPositives;
    const enough = !insufficient && layerPositives >= MIN_LABELS_PER_CLASS && layerNegatives >= MIN_LABELS_PER_CLASS;
    return {
      key: def.key,
      label: def.label,
      scale: def.scale,
      n: pairs.length,
      positives: layerPositives,
      grid: enough ? computeMetricsGrid(pairs) : [],
      bands: enough ? computeBandPerformance(pairs) : null,
    };
  });

  const recommendations = layers
    .filter((l) => l.grid.length > 0)
    .map((l) => recommendThreshold(l.key, l.grid, CURRENT_BANDS.medium, l.n));

  return { labels, layers, agreement: computeAgreementMatrix(samples), recommendations, samples };
}

export interface BuildRiskCalibrationInput {
  orgId: number;
  params: RiskCalibrationParams;
  /** Overridable for deterministic tests. */
  generatedAt?: string;
  deps?: Parameters<typeof estimateMissRate>[2] & {
    scoredMessages?: typeof getScoredMessages;
    coverage?: typeof getAdjudicationCoverage;
    unflaggedCandidates?: typeof getUnflaggedCandidates;
  };
}

export function normalizeParams(
  raw: Partial<RiskCalibrationParams> & { since?: string | null; until?: string | null },
  now = new Date(),
): RiskCalibrationParams {
  const until = raw.until ? new Date(raw.until) : now;
  if (Number.isNaN(until.getTime())) throw new Error('until must be an ISO date');
  const since = raw.since ? new Date(raw.since) : new Date(until.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
  if (Number.isNaN(since.getTime())) throw new Error('since must be an ISO date');
  if (since.getTime() > until.getTime()) throw new Error('since must be on or before until');
  const sampleSize = raw.sample_size === undefined ? DEFAULT_SAMPLE_SIZE : Number(raw.sample_size);
  if (!Number.isInteger(sampleSize) || sampleSize < 0 || sampleSize > MAX_SAMPLE_SIZE) {
    throw new Error(`sample_size must be an integer between 0 and ${MAX_SAMPLE_SIZE}`);
  }
  const seed = raw.seed === undefined ? 20261023 : Number(raw.seed);
  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed must be a non-negative integer');
  const budget = raw.budget_usd === undefined ? MISS_RATE_BUDGET_USD : Number(raw.budget_usd);
  if (!Number.isFinite(budget) || budget < 0 || budget > MISS_RATE_BUDGET_USD) {
    throw new Error(`budget_usd must be between 0 and ${MISS_RATE_BUDGET_USD}`);
  }
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    sample_size: sampleSize,
    seed,
    unflagged_as_negative: raw.unflagged_as_negative ?? true,
    dry_run: raw.dry_run ?? false,
    budget_usd: budget,
  };
}

export async function buildRiskCalibrationReport(input: BuildRiskCalibrationInput): Promise<RiskCalibrationReport> {
  const { orgId, params } = input;
  const irbOrgId = await getIrbStudyOrgId();
  const w: IrbWindow = {
    from: params.since,
    to: params.until,
    orgId,
    includeUnattributed: irbOrgId !== null && irbOrgId === orgId,
  };
  const deps = input.deps ?? {};
  const [rows, coverage, candidates] = await Promise.all([
    (deps.scoredMessages ?? getScoredMessages)(w),
    (deps.coverage ?? getAdjudicationCoverage)(w),
    (deps.unflaggedCandidates ?? getUnflaggedCandidates)(w),
  ]);
  const { labels, layers, agreement, recommendations } = assembleLabelReport(
    rows,
    coverage,
    params.unflagged_as_negative,
  );
  const missRate = await estimateMissRate(candidates, params, deps);
  return {
    meta: {
      generated_at: input.generatedAt ?? new Date().toISOString(),
      git_sha: gitSha(),
      org_id: orgId,
      window: { from: params.since, to: params.until },
    },
    label_rule: LABEL_RULE,
    labels,
    current_bands: CURRENT_BANDS,
    layers,
    agreement,
    recommendations,
    advisory: true,
    miss_rate: missRate,
  };
}

/** Recommended thresholds as a compact {layer: threshold} map for the run row. */
export function recommendedThresholdMap(report: RiskCalibrationReport): Record<string, unknown> {
  const out: Record<string, unknown> = {
    advisory: true,
    basis: 'F1-maximising grid threshold vs the medium band (50)',
  };
  for (const r of report.recommendations) out[r.layer] = r.recommended;
  return out;
}

export async function runAndStoreRiskCalibration(input: {
  orgId: number;
  params: RiskCalibrationParams;
  createdBy: string;
  deps?: BuildRiskCalibrationInput['deps'];
}): Promise<RiskCalibrationRunRow> {
  const startedAt = new Date().toISOString();
  const report = await buildRiskCalibrationReport({ orgId: input.orgId, params: input.params, deps: input.deps });
  const finishedAt = new Date().toISOString();
  const row = await insertRiskCalibrationRun({
    orgId: input.orgId,
    startedAt,
    finishedAt,
    params: { ...input.params },
    report: report as unknown as Record<string, unknown>,
    recommendedThresholds: recommendedThresholdMap(report),
    createdBy: input.createdBy,
  });
  log.info(
    `[riskCalibration] stored run #${row.run_id} for org ${input.orgId}: ${report.labels.scored_messages} scored, ` +
      `${report.labels.positives}+/${report.labels.negatives}- (${report.labels.insufficient_labels ? 'insufficient labels' : 'metrics computed'}), ` +
      `miss-rate sample ${report.miss_rate?.scored ?? 0}/${report.miss_rate?.sampled ?? 0} scored, $${report.miss_rate?.spend_usd ?? 0}`,
  );
  return row;
}
