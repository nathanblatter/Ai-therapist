// Judge calibration (ai-therapist-80): compares human rater scores against the
// LLM judge on the shared six-dimension rubric and reports quadratic weighted
// Cohen's kappa per dimension. Pure math + one DB-backed orchestrator; no
// OpenAI/secrets imports so this stays cheap to unit-test.
import {
  getCalibrationPairs,
  getHumanRatingPairs,
  getSessionEvalJudgeRuns,
  getHighDisagreementEvals,
  type HumanRatingRubric,
  type HumanRatingPairRow,
  type SessionEvalJudgeRow,
} from '../db/index.js';
import { EVAL_DIMENSIONS, medianScore } from './sessionEval.service.js';

// Bump together with EVAL_DIMENSIONS changes.
export const HUMAN_RUBRIC_VERSION = 'v1';

// Interpretation thresholds for a weighted kappa (used by the UI).
export const KAPPA_BANDS = [
  { min: 0.8, label: 'almost perfect' },
  { min: 0.6, label: 'substantial' },
  { min: 0.4, label: 'moderate' },
  { min: 0.2, label: 'fair' },
  { min: -1, label: 'poor' },
] as const;

/**
 * Quadratic weighted Cohen's kappa for two equal-length integer arrays with
 * ratings on the 1..k scale (here k = 5).
 *
 *   disagreement weight  w[i][j] = (i - j)^2 / (k - 1)^2        (0-indexed categories)
 *   O[i][j] = observed count of (rater1 = i, rater2 = j) / n     (joint proportions)
 *   E[i][j] = p1[i] * p2[j]        (product of the two marginal distributions)
 *   kappa   = 1 - ( Σ_ij w[i][j] * O[i][j] ) / ( Σ_ij w[i][j] * E[i][j] )
 *
 * Returns null when n < minN (default 5) or when the expected-disagreement
 * denominator is 0 (both raters constant on the same value — kappa undefined).
 */
export function quadraticWeightedKappa(a: number[], b: number[], k = 5, minN = 5): number | null {
  const n = a.length;
  if (n !== b.length || n < minN) return null;

  const w = (i: number, j: number) => ((i - j) * (i - j)) / ((k - 1) * (k - 1));

  // Marginals over categories 0..k-1 (scores are 1..k → index score-1).
  const p1 = new Array(k).fill(0);
  const p2 = new Array(k).fill(0);
  // Observed joint counts.
  const O: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let idx = 0; idx < n; idx++) {
    const i = a[idx] - 1;
    const j = b[idx] - 1;
    O[i][j] += 1;
    p1[i] += 1;
    p2[j] += 1;
  }

  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const weight = w(i, j);
      num += weight * (O[i][j] / n);
      den += weight * ((p1[i] / n) * (p2[j] / n));
    }
  }
  if (den === 0) return null; // no expected disagreement (both constant) — undefined
  return 1 - num / den;
}

export interface DimensionCalibration {
  dimension: string;
  n: number;
  kappa: number | null;
  human_mean: number | null;
  llm_mean: number | null;
  mean_bias: number | null; // llm_mean - human_mean (positive = judge scores higher)
  exact_agreement_pct: number | null; // % where human == llm score
}

export interface CalibrationReport {
  prompt_version: string;
  rubric_version: string;
  pair_count: number; // (session, rater) pairs
  session_count: number; // distinct sessions
  dimensions: DimensionCalibration[]; // in EVAL_DIMENSIONS order
  overall_kappa: number | null; // kappa over ALL dimensions' pooled score pairs
}

function isValidScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Fetches pairs via getCalibrationPairs and computes the report. Skips a
 *  dimension pair when either side is missing that key or has a non-1..5 score. */
export async function computeCalibrationReport(promptVersion: string): Promise<CalibrationReport> {
  const pairs = await getCalibrationPairs(promptVersion, HUMAN_RUBRIC_VERSION);
  const sessions = new Set(pairs.map((p) => p.session_id));

  const pooledHuman: number[] = [];
  const pooledLlm: number[] = [];

  const dimensions: DimensionCalibration[] = EVAL_DIMENSIONS.map((dim) => {
    const human: number[] = [];
    const llm: number[] = [];
    for (const pair of pairs) {
      const h = pair.human_rubric?.[dim]?.score;
      const l = pair.llm_rubric?.[dim]?.score;
      if (isValidScore(h) && isValidScore(l)) {
        human.push(h);
        llm.push(l);
        pooledHuman.push(h);
        pooledLlm.push(l);
      }
    }
    const n = human.length;
    const hMean = mean(human);
    const lMean = mean(llm);
    const exact = n ? (human.filter((v, i) => v === llm[i]).length / n) * 100 : null;
    return {
      dimension: dim,
      n,
      kappa: quadraticWeightedKappa(human, llm),
      human_mean: hMean,
      llm_mean: lMean,
      mean_bias: hMean !== null && lMean !== null ? lMean - hMean : null,
      exact_agreement_pct: exact,
    };
  });

  return {
    prompt_version: promptVersion,
    rubric_version: HUMAN_RUBRIC_VERSION,
    pair_count: pairs.length,
    session_count: sessions.size,
    dimensions,
    overall_kappa: quadraticWeightedKappa(pooledHuman, pooledLlm),
  };
}

// ---------------------------------------------------------------------------
// Human-human agreement (eval program WP2): inter-rater reliability over
// double-rated sessions, reported next to human-judge kappa.
// ---------------------------------------------------------------------------

/** Paired ratings needed before the auto-run rule (kappa >= 0.6 on every
 *  dimension) is considered measured, for both human-judge and human-human. */
export const CALIBRATION_MIN_PAIRS = 20;

export interface HumanAgreementDimension {
  dimension: string;
  n: number; // rater pairs with a valid score on both sides
  kappa: number | null;
  exact_agreement_pct: number | null;
  /** % of pairs where the two humans differ by 2 or more points. */
  major_disagreement_pct: number | null;
}

export interface HumanAgreementReport {
  rubric_version: string;
  /** Unordered rater pairs (a session with three raters contributes three). */
  pair_count: number;
  /** Distinct sessions with two or more raters. */
  session_count: number;
  /** Paired ratings still needed to reach CALIBRATION_MIN_PAIRS. */
  pairs_needed: number;
  target_pairs: number;
  dimensions: HumanAgreementDimension[]; // EVAL_DIMENSIONS order
  overall_kappa: number | null;
}

/** Pure: human-human weighted kappa per dimension over rater pairs. */
export function computeHumanAgreement(pairs: HumanRatingPairRow[], rubricVersion: string): HumanAgreementReport {
  const sessions = new Set(pairs.map((p) => p.session_id));
  const pooledA: number[] = [];
  const pooledB: number[] = [];
  const dimensions: HumanAgreementDimension[] = EVAL_DIMENSIONS.map((dim) => {
    const a: number[] = [];
    const b: number[] = [];
    for (const pair of pairs) {
      const sa = pair.rubric_a?.[dim]?.score;
      const sb = pair.rubric_b?.[dim]?.score;
      if (isValidScore(sa) && isValidScore(sb)) {
        a.push(sa);
        b.push(sb);
        pooledA.push(sa);
        pooledB.push(sb);
      }
    }
    const n = a.length;
    return {
      dimension: dim,
      n,
      kappa: quadraticWeightedKappa(a, b),
      exact_agreement_pct: n ? (a.filter((v, i) => v === b[i]).length / n) * 100 : null,
      major_disagreement_pct: n ? (a.filter((v, i) => Math.abs(v - b[i]) >= 2).length / n) * 100 : null,
    };
  });
  return {
    rubric_version: rubricVersion,
    pair_count: pairs.length,
    session_count: sessions.size,
    pairs_needed: Math.max(0, CALIBRATION_MIN_PAIRS - sessions.size),
    target_pairs: CALIBRATION_MIN_PAIRS,
    dimensions,
    overall_kappa: quadraticWeightedKappa(pooledA, pooledB),
  };
}

/** DB-backed orchestrator for the admin calibration endpoint. */
export async function computeHumanAgreementReport(): Promise<HumanAgreementReport> {
  return computeHumanAgreement(await getHumanRatingPairs(HUMAN_RUBRIC_VERSION), HUMAN_RUBRIC_VERSION);
}

export interface HumanRubricValidation {
  ok: boolean;
  error?: string;
  rubric?: HumanRatingRubric;
  overallNotes?: string | null;
}

/**
 * Validate a human-rating request body: rubric must contain EXACTLY the keys in
 * EVAL_DIMENSIONS, each with an integer score 1..5 and an optional string note;
 * overall_notes optional string <= 4000 chars. Placed here (not in the route)
 * so it is import-testable without Express.
 */
export function validateHumanRubric(body: unknown): HumanRubricValidation {
  const b = body as { rubric?: unknown; overall_notes?: unknown } | null;
  if (!b || typeof b !== 'object') return { ok: false, error: 'Missing request body' };

  const rubric = b.rubric;
  if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) {
    return { ok: false, error: 'rubric must be an object' };
  }
  const keys = Object.keys(rubric as Record<string, unknown>);
  const expected = [...EVAL_DIMENSIONS];
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) {
    return { ok: false, error: `rubric must contain exactly these keys: ${expected.join(', ')}` };
  }

  const cleaned: HumanRatingRubric = {};
  for (const dim of expected) {
    const entry = (rubric as Record<string, unknown>)[dim] as { score?: unknown; note?: unknown };
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `rubric.${dim} must be an object` };
    }
    const score = entry.score;
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      return { ok: false, error: `rubric.${dim}.score must be an integer 1..5` };
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      return { ok: false, error: `rubric.${dim}.note must be a string` };
    }
    cleaned[dim] = { score };
    if (typeof entry.note === 'string' && entry.note.trim()) cleaned[dim].note = entry.note.trim();
  }

  let overallNotes: string | null = null;
  if (b.overall_notes !== undefined && b.overall_notes !== null) {
    if (typeof b.overall_notes !== 'string') return { ok: false, error: 'overall_notes must be a string' };
    if (b.overall_notes.length > 4000) return { ok: false, error: 'overall_notes exceeds 4000 characters' };
    overallNotes = b.overall_notes.trim() || null;
  }

  return { ok: true, rubric: cleaned, overallNotes };
}

// ---------------------------------------------------------------------------
// Judge ensemble agreement (eval spec G6, migration 107)
// ---------------------------------------------------------------------------

export interface JudgePairDimension {
  dimension: string;
  n: number;
  kappa: number | null;
  exact_agreement_pct: number | null;
  /** mean(judge_b) - mean(judge_a); positive = judge_b scores higher. */
  mean_bias: number | null;
  /** % of sessions where the two judges differ by 2 or more points. */
  major_disagreement_pct: number | null;
}

export interface JudgePairAgreement {
  judge_a: string;
  judge_b: string;
  /** Sessions scored by BOTH judges. */
  n: number;
  dimensions: JudgePairDimension[]; // EVAL_DIMENSIONS order
  overall_kappa: number | null;
}

export interface SelfConsistencyDimension {
  dimension: string;
  n: number; // sessions with >= 2 runs of this judge
  /** % of sessions where every run gave the same score. */
  exact_pct: number | null;
  mean_spread: number | null; // mean(max - min) across sessions
}

export interface SelfConsistencyReport {
  judge_model: string;
  /** Max runs observed per session for this judge. */
  runs: number;
  n: number;
  dimensions: SelfConsistencyDimension[];
}

export interface JudgeAgreementReport {
  prompt_version: string;
  /** Distinct judge models with stored runs for this prompt version. */
  judges: string[];
  /** Sessions with at least one stored judge run. */
  session_count: number;
  pairs: JudgePairAgreement[];
  self_consistency: SelfConsistencyReport[];
  /** Consensus rows with the largest max-dimension spread, for human review. */
  high_disagreement: Array<{ session_id: string; max_spread: number; judge_spread: Record<string, number> }>;
}

type ScoreMap = Map<string, Map<string, number[]>>; // judge -> session -> [score per run]

/** Per (judge, session) the list of run scores for one dimension. */
function collectScores(rows: SessionEvalJudgeRow[], dim: string): ScoreMap {
  const out: ScoreMap = new Map();
  for (const row of rows) {
    const score = row.rubric?.[dim]?.score;
    if (!isValidScore(score)) continue;
    let bySession = out.get(row.judge_model);
    if (!bySession) {
      bySession = new Map();
      out.set(row.judge_model, bySession);
    }
    const list = bySession.get(row.session_id) ?? [];
    list.push(score);
    bySession.set(row.session_id, list);
  }
  return out;
}

/**
 * Pure: inter-judge agreement over stored judge runs. For a judge with several
 * self-consistency runs, its per-session score is the median of its runs (the
 * same reduction the consensus uses), so pair kappas compare judge-vs-judge
 * rather than run-vs-run. Pairs are every unordered combination of judges in
 * first-seen order; a pair with no shared sessions still appears with n = 0.
 */
export function computeJudgeAgreement(
  rows: SessionEvalJudgeRow[],
  promptVersion: string,
  highDisagreement: Array<{ session_id: string; judge_spread: Record<string, number> }> = [],
): JudgeAgreementReport {
  const judges: string[] = [];
  const sessions = new Set<string>();
  for (const row of rows) {
    if (!judges.includes(row.judge_model)) judges.push(row.judge_model);
    sessions.add(row.session_id);
  }
  const perDim = new Map<string, ScoreMap>(EVAL_DIMENSIONS.map((d) => [d, collectScores(rows, d)]));

  const pairs: JudgePairAgreement[] = [];
  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      const [ja, jb] = [judges[i], judges[j]];
      const pooledA: number[] = [];
      const pooledB: number[] = [];
      const shared = new Set<string>();
      const dimensions: JudgePairDimension[] = EVAL_DIMENSIONS.map((dim) => {
        const scores = perDim.get(dim)!;
        const a: number[] = [];
        const b: number[] = [];
        for (const [sessionId, runsA] of scores.get(ja) ?? []) {
          const runsB = scores.get(jb)?.get(sessionId);
          if (!runsB) continue;
          shared.add(sessionId);
          a.push(medianScore(runsA));
          b.push(medianScore(runsB));
        }
        pooledA.push(...a);
        pooledB.push(...b);
        const n = a.length;
        const meanA = mean(a);
        const meanB = mean(b);
        return {
          dimension: dim,
          n,
          kappa: quadraticWeightedKappa(a, b),
          exact_agreement_pct: n ? (a.filter((v, idx) => v === b[idx]).length / n) * 100 : null,
          mean_bias: meanA !== null && meanB !== null ? meanB - meanA : null,
          major_disagreement_pct: n ? (a.filter((v, idx) => Math.abs(v - b[idx]) >= 2).length / n) * 100 : null,
        };
      });
      pairs.push({
        judge_a: ja,
        judge_b: jb,
        n: shared.size,
        dimensions,
        overall_kappa: quadraticWeightedKappa(pooledA, pooledB),
      });
    }
  }

  const self_consistency: SelfConsistencyReport[] = [];
  for (const judge of judges) {
    let maxRuns = 1;
    const multi = new Set<string>();
    const dimensions: SelfConsistencyDimension[] = EVAL_DIMENSIONS.map((dim) => {
      const spreads: number[] = [];
      let exact = 0;
      for (const [sessionId, runs] of perDim.get(dim)!.get(judge) ?? []) {
        maxRuns = Math.max(maxRuns, runs.length);
        if (runs.length < 2) continue;
        multi.add(sessionId);
        const spread = Math.max(...runs) - Math.min(...runs);
        spreads.push(spread);
        if (spread === 0) exact++;
      }
      const n = spreads.length;
      return { dimension: dim, n, exact_pct: n ? (exact / n) * 100 : null, mean_spread: mean(spreads) };
    });
    if (maxRuns > 1) self_consistency.push({ judge_model: judge, runs: maxRuns, n: multi.size, dimensions });
  }

  return {
    prompt_version: promptVersion,
    judges,
    session_count: sessions.size,
    pairs,
    self_consistency,
    high_disagreement: highDisagreement.map((h) => ({
      session_id: h.session_id,
      max_spread: Object.values(h.judge_spread).reduce((m, v) => Math.max(m, Number(v) || 0), 0),
      judge_spread: h.judge_spread,
    })),
  };
}

/** DB-backed orchestrator for the admin calibration endpoint. */
export async function computeJudgeAgreementReport(promptVersion: string): Promise<JudgeAgreementReport> {
  const [rows, high] = await Promise.all([
    getSessionEvalJudgeRuns(promptVersion),
    getHighDisagreementEvals(promptVersion, 10),
  ]);
  return computeJudgeAgreement(rows, promptVersion, high);
}
