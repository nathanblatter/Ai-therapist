// Rating-queue sampler (eval program WP2, ai-therapist-196): picks ended
// sessions for blind human rating, stratified by modality x risk band x ISO
// week with crisis-adjacent sessions oversampled, and marks a configurable
// fraction for a second independent rater. The allocation is pure and seeded
// so a dry run and the real run agree and tests are deterministic; the DB
// orchestrators at the bottom are the only impure code.
import {
  getRatingCandidates,
  getRatingCandidatesByIds,
  insertRatingQueueRows,
  type RatingCandidateRow,
  type RatingQueueRow,
  type RatingQueueSource,
} from '../db/index.js';
import { getSystemConfig } from '../utils/sessionHelpers.js';

export const DEFAULT_SECOND_RATER_FRACTION = 0.2;
/** Weight multiplier for crisis-adjacent sessions in the allocation. */
export const DEFAULT_CRISIS_OVERSAMPLE = 3;
export const DEFAULT_SAMPLE_SINCE_DAYS = 90;

export type RiskBand = 'none' | 'low' | 'moderate' | 'high';
export type Modality = 'voice' | 'chat';

/** Risk bands mirror the crisis-pipeline thresholds (>= 25 / 50 / 75). */
export function riskBand(maxRiskScore: number | null | undefined): RiskBand {
  const s = Number(maxRiskScore) || 0;
  if (s >= 75) return 'high';
  if (s >= 50) return 'moderate';
  if (s >= 25) return 'low';
  return 'none';
}

/** therapy_sessions.session_type -> the modality the rubric is judged under. */
export function modalityOf(sessionType: string | null | undefined): Modality {
  return sessionType === 'realtime' || sessionType === 'voice' ? 'voice' : 'chat';
}

/** ISO-8601 week key, e.g. 2026-W42 (weeks start Monday; week 1 holds Jan 4). */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Sunday -> 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** A session is crisis-adjacent when it was flagged, produced a crisis event,
 *  or its peak risk score reached the moderate band. */
export function isCrisisAdjacent(c: Pick<RatingCandidateRow, 'crisis_flagged' | 'crisis_event_count' | 'max_risk_score'>): boolean {
  return Boolean(c.crisis_flagged) || Number(c.crisis_event_count) > 0 || riskBand(c.max_risk_score) !== 'none' && riskBand(c.max_risk_score) !== 'low';
}

export function stratumOf(c: Pick<RatingCandidateRow, 'session_type' | 'max_risk_score' | 'ended_at'>): string {
  return `${modalityOf(c.session_type)}|${riskBand(c.max_risk_score)}|${isoWeekKey(new Date(c.ended_at))}`;
}

/** Small seeded PRNG (mulberry32) so sampling is reproducible for a seed. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SamplePick {
  session_id: string;
  stratum: string;
  crisis_adjacent: boolean;
  needs_second_rater: boolean;
}

export interface StratifyOptions {
  size: number;
  seed?: number;
  secondRaterFraction?: number;
  crisisOversample?: number;
}

export interface StratumAllocation {
  stratum: string;
  candidates: number;
  crisis_adjacent: number;
  allocated: number;
}

export interface StratifiedSample {
  picks: SamplePick[];
  allocations: StratumAllocation[]; // sorted by stratum key
}

/**
 * Pure stratified allocation:
 *  1. every non-empty stratum gets one slot first (coverage), in stratum-key
 *     order, while the budget lasts;
 *  2. the remaining budget is split across strata in proportion to their
 *     weight (one per session, `crisisOversample` per crisis-adjacent
 *     session), largest remainder, capped at the stratum's remaining
 *     candidates; any capacity freed by a cap is handed to the strata with
 *     the next-largest remainders;
 *  3. within a stratum, sessions are drawn without replacement with weight
 *     (crisis-adjacent first in expectation) via the seeded RNG;
 *  4. each pick is marked for a second rater with probability
 *     `secondRaterFraction` from the same RNG stream.
 */
export function stratifySample(candidates: RatingCandidateRow[], opts: StratifyOptions): StratifiedSample {
  const size = Math.max(0, Math.floor(opts.size));
  const rng = seededRng(opts.seed ?? 1);
  const oversample = opts.crisisOversample ?? DEFAULT_CRISIS_OVERSAMPLE;
  const fraction = Math.min(1, Math.max(0, opts.secondRaterFraction ?? DEFAULT_SECOND_RATER_FRACTION));

  // Group by stratum (deterministic: candidates sorted by session_id).
  const groups = new Map<string, Array<{ c: RatingCandidateRow; crisis: boolean }>>();
  for (const c of [...candidates].sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0))) {
    const key = stratumOf(c);
    const list = groups.get(key) ?? [];
    list.push({ c, crisis: isCrisisAdjacent(c) });
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort();
  const allocated = new Map<string, number>(keys.map(k => [k, 0]));
  let budget = Math.min(size, candidates.length);

  // 1. coverage
  for (const k of keys) {
    if (budget === 0) break;
    allocated.set(k, 1);
    budget--;
  }

  // 2. proportional by weight with largest remainder, capped by remaining candidates
  while (budget > 0) {
    const open = keys.filter(k => groups.get(k)!.length - allocated.get(k)! > 0);
    if (open.length === 0) break;
    const weight = (k: string) => groups.get(k)!.reduce((s, x) => s + (x.crisis ? oversample : 1), 0);
    const total = open.reduce((s, k) => s + weight(k), 0);
    const shares = open.map(k => {
      const cap = groups.get(k)!.length - allocated.get(k)!;
      const exact = (budget * weight(k)) / total;
      const whole = Math.min(cap, Math.floor(exact));
      return { k, whole, remainder: exact - Math.floor(exact), cap };
    });
    let used = 0;
    for (const s of shares) { allocated.set(s.k, allocated.get(s.k)! + s.whole); used += s.whole; }
    // Largest remainders take the leftover, one each, while capacity remains.
    const byRemainder = shares
      .filter(s => s.cap - s.whole > 0)
      .sort((a, b) => b.remainder - a.remainder || (a.k < b.k ? -1 : 1));
    for (const s of byRemainder) {
      if (used >= budget) break;
      allocated.set(s.k, allocated.get(s.k)! + 1);
      used++;
    }
    budget -= used;
    if (used === 0) break;
  }

  // 3. weighted draw within each stratum (Efraimidis-Spirakis keys)
  const picks: SamplePick[] = [];
  const allocations: StratumAllocation[] = [];
  for (const k of keys) {
    const list = groups.get(k)!;
    const n = allocated.get(k)!;
    const keyed = list.map(x => ({ x, key: Math.pow(rng(), 1 / (x.crisis ? oversample : 1)) }));
    keyed.sort((a, b) => b.key - a.key || (a.x.c.session_id < b.x.c.session_id ? -1 : 1));
    for (const { x } of keyed.slice(0, n)) {
      picks.push({
        session_id: x.c.session_id,
        stratum: k,
        crisis_adjacent: x.crisis,
        needs_second_rater: rng() < fraction,
      });
    }
    allocations.push({ stratum: k, candidates: list.length, crisis_adjacent: list.filter(x => x.crisis).length, allocated: n });
  }
  return { picks, allocations };
}

/** system_config.evals.rating_second_rater_fraction, clamped to 0..1. */
export async function getSecondRaterFraction(): Promise<number> {
  const config = await getSystemConfig();
  const evals = (config.evals ?? {}) as { rating_second_rater_fraction?: unknown };
  const v = Number(evals.rating_second_rater_fraction);
  if (!Number.isFinite(v)) return DEFAULT_SECOND_RATER_FRACTION;
  return Math.min(1, Math.max(0, v));
}

export interface EnqueueSampleOptions {
  size: number;
  since?: Date;
  seed?: number;
  dryRun?: boolean;
  enqueuedBy?: number | null;
  secondRaterFraction?: number;
}

export interface EnqueueSampleResult {
  dry_run: boolean;
  since: string;
  seed: number;
  second_rater_fraction: number;
  candidate_count: number;
  picks: SamplePick[];
  allocations: StratumAllocation[];
  /** Rows actually inserted (empty on a dry run). */
  inserted: RatingQueueRow[];
}

/** DB orchestrator: sample from the candidate pool and (unless dryRun) insert. */
export async function enqueueStratifiedSample(opts: EnqueueSampleOptions): Promise<EnqueueSampleResult> {
  const since = opts.since ?? new Date(Date.now() - DEFAULT_SAMPLE_SINCE_DAYS * 86400000);
  const seed = opts.seed ?? Math.floor(Date.now() / 1000);
  const fraction = opts.secondRaterFraction ?? (await getSecondRaterFraction());
  const candidates = await getRatingCandidates(since);
  const { picks, allocations } = stratifySample(candidates, { size: opts.size, seed, secondRaterFraction: fraction });
  const inserted = opts.dryRun
    ? []
    : await insertRatingQueueRows(
        picks.map(p => ({ ...p, source: 'stratified' as const })),
        opts.enqueuedBy ?? null
      );
  return {
    dry_run: Boolean(opts.dryRun),
    since: since.toISOString(),
    seed,
    second_rater_fraction: fraction,
    candidate_count: candidates.length,
    picks,
    allocations,
    inserted,
  };
}

/**
 * Enqueue specific sessions (judge-disagreement list or by hand). Sessions
 * that are not ended / demo / sandbox-owned are reported back as skipped;
 * already-queued sessions are silently kept. Second-rater marking uses the
 * configured fraction with a seed derived from the session id so repeated
 * calls agree.
 */
export async function enqueueSessions(
  sessionIds: string[],
  source: Exclude<RatingQueueSource, 'stratified'>,
  enqueuedBy: number | null,
  secondRaterFraction?: number
): Promise<{ inserted: RatingQueueRow[]; skipped: string[] }> {
  const fraction = secondRaterFraction ?? (await getSecondRaterFraction());
  const candidates = await getRatingCandidatesByIds(sessionIds);
  const found = new Set(candidates.map(c => c.session_id));
  const rows = candidates.map(c => {
    let h = 0;
    for (const ch of c.session_id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return {
      session_id: c.session_id,
      stratum: stratumOf(c),
      source,
      crisis_adjacent: isCrisisAdjacent(c),
      needs_second_rater: seededRng(h)() < fraction,
    };
  });
  const inserted = await insertRatingQueueRows(rows, enqueuedBy);
  return { inserted, skipped: sessionIds.filter(id => !found.has(id)) };
}
