// Instrument scoring over synced Qualtrics answer payloads (ai-therapist-149).
// QID maps were verified against the live survey definitions on 2026-09-03:
// matrix items export 1-4 ("Not at all".."Nearly every day", no recodes), so
// each PHQ-2/GAD-2 item scores raw-1 (0-3) and the 2-item sum is 0-6 with the
// standard >=3 positive-screen cutoff. If a survey is rebuilt in Qualtrics,
// re-verify these keys — a silent remap would corrupt scores, so score()
// returns null unless every expected item is present and in range.
import type { QualtricsSurveyRole } from '../db/index.js';

interface InstrumentItems {
  phq2: [string, string];
  gad2: [string, string];
}

const SCORE_MAP: Partial<Record<QualtricsSurveyRole, InstrumentItems>> = {
  baseline: { phq2: ['QID21_1', 'QID21_2'], gad2: ['QID22_1', 'QID22_2'] },
  exit: { phq2: ['QID4_1', 'QID4_2'], gad2: ['QID5_1', 'QID5_2'] },
  // Week 12 combines all four items in one matrix: 1-2 PHQ, 3-4 GAD.
  week12: { phq2: ['QID6_1', 'QID6_2'], gad2: ['QID6_3', 'QID6_4'] },
};

// Weekly check-in single-choice metrics (1-based choice indexes, no recodes).
const WEEKLY_KEYS = {
  mood: 'QID8', // 1 Very poor .. 6 Excellent
  stress: 'QID9', // 1 Not at all .. 5 Extremely
  helpfulness: 'QID6', // 1 Not at all .. 5 Extremely; 6 = did not use (excluded)
  usage: 'QID4', // 1 '0', 2 '1', 3 '2-3', 4 '4-6', 5 '7 or more'
} as const;

const USAGE_LABELS: Record<number, string> = { 1: '0', 2: '1', 3: '2-3', 4: '4-6', 5: '7 or more' };

// Weekly W4 alliance matrix: WAI-SR client version (Hatcher & Gillaspy 2006;
// items (c) Adam Horvath), adapted "my therapist" -> "the AI support agent",
// licensed by SPR 2026-09-09 (letter in docs/irb-phase2-instruments). Replaced
// the 6 investigator-developed stopgap items on 2026-09-09 while the survey
// was still Draft (no field data on the old keys). 12 rows in canonical WAI-SR
// item order, 1-5 frequency scale (Seldom..Always, no recodes); subscale
// mapping per the instrument's scoring key.
// VERIFY the matrix QID + row order against live survey-definitions after ANY
// Qualtrics edit — alliance metrics return null unless every item is present
// and in range, so a stale key yields empty columns, never corrupt scores.
const ALLIANCE_MATRIX_QID = 'QID7';
const ALLIANCE_KEYS = {
  task: [1, 2, 10, 12].map((n) => `${ALLIANCE_MATRIX_QID}_${n}`),
  bond: [3, 5, 7, 9].map((n) => `${ALLIANCE_MATRIX_QID}_${n}`),
  goal: [4, 6, 8, 11].map((n) => `${ALLIANCE_MATRIX_QID}_${n}`),
} as const;

export interface InstrumentScores {
  phq2: number | null;
  gad2: number | null;
  phq2Positive: boolean | null;
  gad2Positive: boolean | null;
}

// Paradata (ai-therapist Qualtrics ops): every exported response carries a
// `duration` field (seconds spent in the survey). Responses faster than a
// role's plausible floor are flagged as speeders — a principled exclusion
// rule for analysis, not an automatic exclusion.
const SPEEDER_FLOOR_SECONDS: Record<QualtricsSurveyRole, number> = {
  baseline: 120,
  weekly: 20,
  exit: 90,
  week12: 45,
  withdrawal: 10,
};

export interface SurveyParadata {
  /** Seconds spent in the survey; null when the payload lacks a usable duration. */
  completionSeconds: number | null;
  /** True when completionSeconds is below the role's plausibility floor. */
  speeder: boolean | null;
}

export function surveyParadata(
  role: QualtricsSurveyRole,
  answers: Record<string, unknown>
): SurveyParadata {
  const raw = answers.duration;
  const seconds =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? Math.round(raw)
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? parseInt(raw, 10)
        : null;
  return {
    completionSeconds: seconds,
    speeder: seconds === null ? null : seconds < SPEEDER_FLOOR_SECONDS[role],
  };
}

function itemScore(answers: Record<string, unknown>, key: string): number | null {
  const raw = answers[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 4) return null;
  return raw - 1;
}

function sumItems(answers: Record<string, unknown>, keys: [string, string]): number | null {
  const a = itemScore(answers, keys[0]);
  const b = itemScore(answers, keys[1]);
  return a === null || b === null ? null : a + b;
}

/** PHQ-2/GAD-2 scores (0-6, cutoff >=3) for one response; nulls when the
 *  role has no instrument (weekly) or items are missing/out of range. */
export function scoreInstruments(
  role: QualtricsSurveyRole,
  answers: Record<string, unknown>
): InstrumentScores {
  const map = SCORE_MAP[role];
  if (!map) return { phq2: null, gad2: null, phq2Positive: null, gad2Positive: null };
  const phq2 = sumItems(answers, map.phq2);
  const gad2 = sumItems(answers, map.gad2);
  return {
    phq2,
    gad2,
    phq2Positive: phq2 === null ? null : phq2 >= 3,
    gad2Positive: gad2 === null ? null : gad2 >= 3,
  };
}

export interface WeeklyMetrics {
  /** 1-6, higher = better mood. */
  mood: number | null;
  /** 1-5, higher = more stressed. */
  stress: number | null;
  /** 1-5, null when unanswered or "did not use this week". */
  helpfulness: number | null;
  /** Display bucket for session count, e.g. "2-3". */
  usage: string | null;
  /** Mean of the 4 WAI-SR Task items (1-5); null unless all present and in range. */
  allianceTask: number | null;
  /** Mean of the 4 WAI-SR Bond items (1-5). */
  allianceBond: number | null;
  /** Mean of the 4 WAI-SR Goal items (1-5). */
  allianceGoal: number | null;
  /** Mean of all 12 WAI-SR items (1-5); null unless all subscales scored. */
  allianceTotal: number | null;
}

function choice(answers: Record<string, unknown>, key: string, max: number): number | null {
  const raw = answers[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) return null;
  return raw;
}

function subscaleMean(answers: Record<string, unknown>, keys: readonly string[]): number | null {
  let sum = 0;
  for (const key of keys) {
    const v = choice(answers, key, 5);
    if (v === null) return null;
    sum += v;
  }
  return Math.round((sum / keys.length) * 100) / 100;
}

/** Mood/stress/helpfulness/usage + alliance subscales from a weekly payload. */
export function weeklyMetrics(answers: Record<string, unknown>): WeeklyMetrics {
  const helpRaw = choice(answers, WEEKLY_KEYS.helpfulness, 6);
  const usageRaw = choice(answers, WEEKLY_KEYS.usage, 5);
  const allianceTask = subscaleMean(answers, ALLIANCE_KEYS.task);
  const allianceBond = subscaleMean(answers, ALLIANCE_KEYS.bond);
  const allianceGoal = subscaleMean(answers, ALLIANCE_KEYS.goal);
  const allianceTotal =
    allianceTask === null || allianceBond === null || allianceGoal === null
      ? null
      : Math.round(((allianceTask + allianceBond + allianceGoal) / 3) * 100) / 100;
  return {
    mood: choice(answers, WEEKLY_KEYS.mood, 6),
    stress: choice(answers, WEEKLY_KEYS.stress, 5),
    helpfulness: helpRaw === 6 ? null : helpRaw,
    usage: usageRaw === null ? null : USAGE_LABELS[usageRaw],
    allianceTask,
    allianceBond,
    allianceGoal,
    allianceTotal,
  };
}
