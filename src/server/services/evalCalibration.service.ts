// Judge calibration (ai-therapist-80): compares human rater scores against the
// LLM judge on the shared six-dimension rubric and reports quadratic weighted
// Cohen's kappa per dimension. Pure math + one DB-backed orchestrator; no
// OpenAI/secrets imports so this stays cheap to unit-test.
import { getCalibrationPairs, type HumanRatingRubric } from '../db/index.js';
import { EVAL_DIMENSIONS } from './sessionEval.service.js';

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
  const sessions = new Set(pairs.map(p => p.session_id));

  const pooledHuman: number[] = [];
  const pooledLlm: number[] = [];

  const dimensions: DimensionCalibration[] = EVAL_DIMENSIONS.map(dim => {
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
  if (keys.length !== expected.length || !expected.every(k => keys.includes(k))) {
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
