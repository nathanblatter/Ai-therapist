// Descriptive self-report screening trend over a client's PHQ-2 / GAD-2
// administrations (idea ai-therapist-87, heuristic first step).
//
// WHAT THIS IS: a description of what the client's own screener answers did
// ("PHQ-2 rose from 2 to 4 across the last two administrations"). It is NOT a
// risk prediction, a diagnosis, or a model of anything, and it is entirely
// separate from crisis detection: it never creates, suppresses, or relabels a
// crisis signal. Its only consumer is the daily work-queue sweep, which
// surfaces it to the client's care team as a `screener_trend` item.
//
// Pure and deterministic: no I/O, no clock (the caller passes `now`).
//
// ---------------------------------------------------------------------------
// RULES (a reading is one administration of one scale; scores are 0-6)
// ---------------------------------------------------------------------------
//
// R1 cutoff_crossed — the latest score is >= 3 and the immediately previous
//    administration (in the same contiguous run, see below) was < 3.
//    Source for the >= 3 cutoff on both instruments (the conventional
//    screen-positive point, also used by SCALES[*].cutoff in utils/scales.ts):
//      - PHQ-2: Kroenke K, Spitzer RL, Williams JBW. The Patient Health
//        Questionnaire-2: validity of a two-item depression screener.
//        Med Care. 2003;41(11):1284-1292.
//      - GAD-2: Kroenke K, Spitzer RL, Williams JBW, Monahan PO, Lowe B.
//        Anxiety disorders in primary care: prevalence, impairment,
//        comorbidity, and detection. Ann Intern Med. 2007;146(5):317-325.
//    "From below" is deliberate: a client who has been at or above the cutoff
//    all along is not newly flagged by R1 (that is a level, not a trajectory,
//    and the clinician already sees the level on the TrendTile).
//
// R2 sustained_increase — the last THREE administrations in the run are
//    strictly increasing (s1 < s2 < s3), i.e. two consecutive increases. On
//    an integer 0-6 scale this implies a net rise of at least 2 points.
//    Basis: PHQ-2 change scores track change in depression status (Lowe B,
//    Kroenke K, Grafe K. Detecting and monitoring depression with a two-item
//    questionnaire (PHQ-2). J Psychosom Res. 2005;58(2):163-171), which is
//    what justifies reading direction from repeated PHQ-2s at all. HONEST
//    CAVEAT: we did not find a published reliable-change threshold for the
//    PHQ-2 or GAD-2, so "two consecutive increases" is an operational run
//    rule, not a validated clinical threshold. Requiring two increases (not
//    one) is what keeps a single one-point fluctuation from flagging. This is
//    the rule the study's clinical consultant should review first.
//
// Never flags on a single reading: R1 needs a previous reading to cross from,
// R2 needs three. A client's FIRST administration is never flagged even if it
// is >= 3 (no trajectory exists yet).
//
// RECOVERY (lets the sweep expire an open item): the latest reading is below
// the cutoff AND is not higher than the previous reading in the run (or has
// no previous reading in the run). A score that dips but stays >= 3 does not
// count as recovered; neither does one that is still climbing below the cutoff.
//
// ---------------------------------------------------------------------------
// MISSING DATA AND IRREGULAR SPACING (operational parameters, not clinical)
// ---------------------------------------------------------------------------
// - Invalid readings (non-integer score, outside 0..max, unparseable time)
//   are dropped and counted in `droppedInvalid`; they never break or join a run.
// - Readings are ordered by administration time (ties by response id).
// - Contiguous run: consecutive readings more than MAX_GAP_DAYS apart are not
//   compared with each other. The run is the trailing stretch of readings
//   ending at the latest one with no larger gap. (PHQ-2/GAD-2 ask about the
//   last two weeks and are administered at most weekly here; 42 days is three
//   recall windows. A rise across a two-month silence is not a trajectory.)
// - Staleness: if the latest reading is older than RECENCY_DAYS, the result
//   is `insufficient_data` (reason 'stale') — old data neither raises a new
//   flag nor counts as recovery. Disengagement is the inactivity item's job.

import { SCALES } from './scales.js';

export const TREND_SCALES = ['phq2', 'gad2'] as const;
export type TrendScale = (typeof TREND_SCALES)[number];

/** Screen-positive cutoff (>= 3) for both instruments; see R1 sources above. */
export const SCREENING_CUTOFF = 3;
/** Readings further apart than this are not compared (operational). */
export const MAX_GAP_DAYS = 42;
/** A latest reading older than this is too old to act on (operational). */
export const RECENCY_DAYS = 30;
/** Readings needed for R2 (sustained_increase). R1 needs 2. */
export const SUSTAINED_RUN_LENGTH = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScreenerReading {
  responseId: number;
  score: number;
  administeredAt: Date | string;
}

export type TrendRule = 'cutoff_crossed' | 'sustained_increase';

export type InsufficientReason = 'no_valid_readings' | 'stale' | 'too_few_points';

export type ScreenerTrendResult =
  | { status: 'insufficient_data'; reason: InsufficientReason; droppedInvalid: number }
  | {
      status: 'worsening';
      rules: TrendRule[];
      /** The readings the rules looked at, oldest first (2 or 3 of them). */
      scores: number[];
      fromScore: number;
      toScore: number;
      latestResponseId: number;
      latestAt: string;
      /** Plain-language description of what was observed. */
      observation: string;
      droppedInvalid: number;
    }
  | { status: 'recovered'; latestScore: number; latestResponseId: number; droppedInvalid: number }
  | { status: 'no_change'; latestScore: number; latestResponseId: number; droppedInvalid: number };

interface ValidReading {
  responseId: number;
  score: number;
  at: Date;
}

const DISPLAY_NAME: Record<TrendScale, string> = { phq2: 'PHQ-2', gad2: 'GAD-2' };

export function scaleDisplayName(scale: TrendScale): string {
  return DISPLAY_NAME[scale];
}

function toValid(reading: ScreenerReading, maxScore: number): ValidReading | null {
  const at = reading.administeredAt instanceof Date ? reading.administeredAt : new Date(reading.administeredAt);
  if (Number.isNaN(at.getTime())) return null;
  if (!Number.isInteger(reading.score) || reading.score < 0 || reading.score > maxScore) return null;
  return { responseId: reading.responseId, score: reading.score, at };
}

function countWord(n: number): string {
  return n === 2 ? 'two' : n === 3 ? 'three' : String(n);
}

/** Descriptive copy only: what the scores did, never what they predict. */
export function describeObservation(scale: TrendScale, scores: number[], rules: TrendRule[]): string {
  const name = DISPLAY_NAME[scale];
  const from = scores[0];
  const to = scores[scores.length - 1];
  const sentences: string[] = [];
  if (rules.includes('sustained_increase')) {
    sentences.push(
      `${name} rose from ${from} to ${to} across the last ${countWord(scores.length)} administrations (${scores.join(', ')}).`,
    );
  } else {
    sentences.push(`${name} rose from ${from} to ${to} across the last two administrations.`);
  }
  if (rules.includes('cutoff_crossed')) {
    sentences.push(`The latest score is at or above the standard screening cutoff of ${SCREENING_CUTOFF}.`);
  }
  return sentences.join(' ');
}

/**
 * Evaluate one client's series for one scale. `readings` may be in any order
 * and may include invalid rows (they are dropped and counted).
 */
export function evaluateScreenerTrend(scale: TrendScale, readings: ScreenerReading[], now: Date): ScreenerTrendResult {
  const maxScore = SCALES[scale].max_score;
  const valid: ValidReading[] = [];
  for (const reading of readings) {
    const v = toValid(reading, maxScore);
    if (v) valid.push(v);
  }
  const droppedInvalid = readings.length - valid.length;
  if (valid.length === 0) return { status: 'insufficient_data', reason: 'no_valid_readings', droppedInvalid };

  valid.sort((a, b) => a.at.getTime() - b.at.getTime() || a.responseId - b.responseId);
  const latest = valid[valid.length - 1];
  if (now.getTime() - latest.at.getTime() > RECENCY_DAYS * DAY_MS) {
    return { status: 'insufficient_data', reason: 'stale', droppedInvalid };
  }

  // Trailing contiguous run ending at the latest reading (at most 3 needed).
  const run: ValidReading[] = [latest];
  for (let i = valid.length - 2; i >= 0 && run.length < SUSTAINED_RUN_LENGTH; i--) {
    if (run[0].at.getTime() - valid[i].at.getTime() > MAX_GAP_DAYS * DAY_MS) break;
    run.unshift(valid[i]);
  }

  const previous = run.length >= 2 ? run[run.length - 2] : null;

  // Recovery can be judged from the latest reading alone (it only ever
  // clears an item; it never raises one).
  const recovered = latest.score < SCREENING_CUTOFF && (previous === null || latest.score <= previous.score);

  if (previous === null) {
    if (recovered) {
      return { status: 'recovered', latestScore: latest.score, latestResponseId: latest.responseId, droppedInvalid };
    }
    return { status: 'insufficient_data', reason: 'too_few_points', droppedInvalid };
  }

  const rules: TrendRule[] = [];
  if (previous.score < SCREENING_CUTOFF && latest.score >= SCREENING_CUTOFF) rules.push('cutoff_crossed');
  if (run.length >= SUSTAINED_RUN_LENGTH && run[0].score < run[1].score && run[1].score < run[2].score) {
    rules.push('sustained_increase');
  }

  if (rules.length > 0) {
    const considered = rules.includes('sustained_increase') ? run : [previous, latest];
    const scores = considered.map((r) => r.score);
    return {
      status: 'worsening',
      rules,
      scores,
      fromScore: scores[0],
      toScore: latest.score,
      latestResponseId: latest.responseId,
      latestAt: latest.at.toISOString(),
      observation: describeObservation(scale, scores, rules),
      droppedInvalid,
    };
  }
  if (recovered) {
    return { status: 'recovered', latestScore: latest.score, latestResponseId: latest.responseId, droppedInvalid };
  }
  return { status: 'no_change', latestScore: latest.score, latestResponseId: latest.responseId, droppedInvalid };
}
