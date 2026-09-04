// Admin-facing survey data aggregation (ai-therapist-149): turns the synced
// qualtrics_responses rows into the study dashboard shape — a per-participant
// completion matrix on the protocol calendar (weeks 1-8 + exit + week 12),
// PHQ-2/GAD-2 trajectories, and weekly mood/stress/helpfulness aggregates.
// Pure computation over query results; scoring lives in
// qualtricsScoring.service.ts with QID maps verified against the live surveys.
import {
  getEnrolledParticipants,
  getEnrollmentFunnel,
  getLinkedSurveyRows,
  type EnrollmentFunnel,
  type LinkedSurveyRow,
} from '../db/index.js';
import {
  scoreInstruments,
  weeklyMetrics,
  type InstrumentScores,
  type WeeklyMetrics,
} from './qualtricsScoring.service.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_WEEKS = 8;

export interface ScoredResponse extends InstrumentScores {
  responseId: string;
  recordedAt: string | null;
}

export interface WeeklyCell extends WeeklyMetrics {
  responseId: string;
  recordedAt: string | null;
}

export interface ParticipantSurveyData {
  userId: number;
  username: string;
  enrolledAt: string;
  /** 1-based current study week (capped display concern is the client's). */
  studyWeek: number;
  /** Weekly check-ins keyed by study week 1-8 (window the response landed in). */
  weekly: Partial<Record<number, WeeklyCell>>;
  /** Weekly responses recorded outside weeks 1-8 (late/early fills, kept visible). */
  weeklyOutOfWindow: number;
  baseline: ScoredResponse | null;
  exit: ScoredResponse | null;
  week12: ScoredResponse | null;
}

export interface WeeklyAggregate {
  week: number;
  n: number;
  avgMood: number | null;
  avgStress: number | null;
  avgHelpfulness: number | null;
}

export interface InstrumentAggregate {
  role: 'baseline' | 'exit' | 'week12';
  n: number;
  avgPhq2: number | null;
  avgGad2: number | null;
  phq2Positive: number;
  gad2Positive: number;
}

export interface SurveyDataOverview {
  participants: ParticipantSurveyData[];
  weeklyAggregates: WeeklyAggregate[];
  instrumentAggregates: InstrumentAggregate[];
  funnel: EnrollmentFunnel;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/** Study week (1-based) a timestamp falls in relative to enrollment, or null
 *  when it precedes enrollment. */
function studyWeekOf(enrolledAt: Date, at: Date): number | null {
  const elapsed = at.getTime() - enrolledAt.getTime();
  if (elapsed < 0) return null;
  return Math.floor(elapsed / WEEK_MS) + 1;
}

export function buildSurveyDataOverview(
  enrolled: Array<{ userId: number; username: string; enrolledAt: Date }>,
  rows: LinkedSurveyRow[],
  now: Date = new Date()
): Omit<SurveyDataOverview, 'funnel'> {
  const byUser = new Map<number, ParticipantSurveyData>();
  for (const p of enrolled) {
    byUser.set(p.userId, {
      userId: p.userId,
      username: p.username,
      enrolledAt: p.enrolledAt.toISOString(),
      studyWeek: Math.max(1, studyWeekOf(p.enrolledAt, now) ?? 1),
      weekly: {},
      weeklyOutOfWindow: 0,
      baseline: null,
      exit: null,
      week12: null,
    });
  }
  const anchors = new Map(enrolled.map((p) => [p.userId, p.enrolledAt]));

  for (const row of rows) {
    // Withdrawal responses carry no scorable instrument; study_status and the
    // participant_withdrawal work item are their analytic surface.
    if (row.surveyRole === 'withdrawal') continue;
    const participant = byUser.get(row.userId);
    // Linked responses from accounts not survey-enrolled (e.g. manually
    // created participants who typed their ID) still count in aggregates
    // below but have no calendar to pin a completion matrix to.
    if (row.surveyRole === 'weekly') {
      if (!participant) continue;
      const anchor = anchors.get(row.userId)!;
      const week = row.recordedAt ? studyWeekOf(new Date(anchor), row.recordedAt) : null;
      if (week !== null && week >= 1 && week <= WEEKLY_WEEKS) {
        // Keep the earliest response per week (rows arrive recorded_at ASC).
        if (!participant.weekly[week]) {
          participant.weekly[week] = {
            responseId: row.responseId,
            recordedAt: iso(row.recordedAt),
            ...weeklyMetrics(row.answers),
          };
        }
      } else {
        participant.weeklyOutOfWindow++;
      }
    } else {
      if (!participant) continue;
      const scored: ScoredResponse = {
        responseId: row.responseId,
        recordedAt: iso(row.recordedAt),
        ...scoreInstruments(row.surveyRole, row.answers),
      };
      // Earliest response wins for a stable record; duplicates are unexpected.
      if (participant[row.surveyRole] === null) participant[row.surveyRole] = scored;
    }
  }

  const participants = [...byUser.values()];

  const weeklyAggregates: WeeklyAggregate[] = [];
  for (let week = 1; week <= WEEKLY_WEEKS; week++) {
    const cells = participants
      .map((p) => p.weekly[week])
      .filter((c): c is WeeklyCell => Boolean(c));
    if (cells.length === 0) continue;
    weeklyAggregates.push({
      week,
      n: cells.length,
      avgMood: avg(cells.map((c) => c.mood).filter((v): v is number => v !== null)),
      avgStress: avg(cells.map((c) => c.stress).filter((v): v is number => v !== null)),
      avgHelpfulness: avg(cells.map((c) => c.helpfulness).filter((v): v is number => v !== null)),
    });
  }

  const instrumentAggregates: InstrumentAggregate[] = [];
  for (const role of ['baseline', 'exit', 'week12'] as const) {
    const scored = participants
      .map((p) => p[role])
      .filter((s): s is ScoredResponse => Boolean(s));
    if (scored.length === 0) continue;
    instrumentAggregates.push({
      role,
      n: scored.length,
      avgPhq2: avg(scored.map((s) => s.phq2).filter((v): v is number => v !== null)),
      avgGad2: avg(scored.map((s) => s.gad2).filter((v): v is number => v !== null)),
      phq2Positive: scored.filter((s) => s.phq2Positive === true).length,
      gad2Positive: scored.filter((s) => s.gad2Positive === true).length,
    });
  }

  return { participants, weeklyAggregates, instrumentAggregates };
}

export async function getSurveyDataOverview(now: Date = new Date()): Promise<SurveyDataOverview> {
  const [enrolled, rows, funnel] = await Promise.all([
    getEnrolledParticipants(),
    getLinkedSurveyRows(),
    getEnrollmentFunnel(),
  ]);
  return { ...buildSurveyDataOverview(enrolled, rows, now), funnel };
}
