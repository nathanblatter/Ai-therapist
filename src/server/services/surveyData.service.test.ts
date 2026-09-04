// Survey data aggregation: completion-matrix week binning against each
// participant's enrollment anchor, out-of-window handling, earliest-wins
// dedup, and the weekly/instrument aggregate math.
import { describe, it, expect } from 'vitest';
import { buildSurveyDataOverview } from './surveyData.service.js';
import type { LinkedSurveyRow } from '../db/index.js';

const DAY = 24 * 60 * 60 * 1000;
const ANCHOR = new Date('2026-09-01T12:00:00Z');
const NOW = new Date(ANCHOR.getTime() + 15 * DAY); // study week 3

const ENROLLED = [
  { userId: 1, username: 'alpha', enrolledAt: ANCHOR },
  { userId: 2, username: 'bravo', enrolledAt: new Date(ANCHOR.getTime() + 7 * DAY) },
];

function weeklyRow(userId: number, daysAfterAnchor: number, id: string, answers = {}): LinkedSurveyRow {
  return {
    userId,
    username: userId === 1 ? 'alpha' : 'bravo',
    surveyRole: 'weekly',
    responseId: id,
    recordedAt: new Date(ANCHOR.getTime() + daysAfterAnchor * DAY),
    answers: { QID8: 4, QID9: 2, QID6: 3, QID4: 3, ...answers },
  };
}

describe('buildSurveyDataOverview', () => {
  it('bins weekly responses into study weeks per participant anchor', () => {
    const rows = [
      weeklyRow(1, 2, 'r1'), // alpha week 1
      weeklyRow(1, 8, 'r2'), // alpha week 2
      weeklyRow(2, 8, 'r3'), // bravo enrolled day 7 -> their week 1
    ];
    const { participants } = buildSurveyDataOverview(ENROLLED, rows, NOW);
    const alpha = participants.find((p) => p.userId === 1)!;
    const bravo = participants.find((p) => p.userId === 2)!;
    expect(Object.keys(alpha.weekly)).toEqual(['1', '2']);
    expect(Object.keys(bravo.weekly)).toEqual(['1']);
    expect(alpha.studyWeek).toBe(3);
    expect(bravo.studyWeek).toBe(2);
  });

  it('keeps the earliest weekly response per week and counts out-of-window fills', () => {
    const rows = [
      weeklyRow(1, 1, 'first', { QID8: 2 }),
      weeklyRow(1, 3, 'second', { QID8: 6 }),
      { ...weeklyRow(1, 2, 'preanchor'), recordedAt: new Date(ANCHOR.getTime() - DAY) },
    ];
    const { participants } = buildSurveyDataOverview(ENROLLED, rows, NOW);
    const alpha = participants.find((p) => p.userId === 1)!;
    expect(alpha.weekly[1]!.responseId).toBe('first');
    expect(alpha.weekly[1]!.mood).toBe(2);
    expect(alpha.weeklyOutOfWindow).toBe(1);
  });

  it('scores baseline/exit responses and aggregates instruments', () => {
    const rows: LinkedSurveyRow[] = [
      {
        userId: 1,
        username: 'alpha',
        surveyRole: 'baseline',
        responseId: 'b1',
        recordedAt: ANCHOR,
        answers: { QID21_1: 4, QID21_2: 4, QID22_1: 1, QID22_2: 1 },
      },
      {
        userId: 2,
        username: 'bravo',
        surveyRole: 'baseline',
        responseId: 'b2',
        recordedAt: ANCHOR,
        answers: { QID21_1: 1, QID21_2: 1, QID22_1: 1, QID22_2: 1 },
      },
    ];
    const { participants, instrumentAggregates } = buildSurveyDataOverview(ENROLLED, rows, NOW);
    expect(participants.find((p) => p.userId === 1)!.baseline!.phq2).toBe(6);
    expect(instrumentAggregates).toEqual([
      { role: 'baseline', n: 2, avgPhq2: 3, avgGad2: 0, phq2Positive: 1, gad2Positive: 0 },
    ]);
  });

  it('averages weekly metrics per week across participants', () => {
    const rows = [
      weeklyRow(1, 1, 'r1', { QID8: 2, QID6: 6 }), // helpfulness "did not use" excluded
      weeklyRow(2, 8, 'r2', { QID8: 6 }), // bravo week 1
    ];
    const { weeklyAggregates } = buildSurveyDataOverview(ENROLLED, rows, NOW);
    expect(weeklyAggregates).toEqual([
      { week: 1, n: 2, avgMood: 4, avgStress: 2, avgHelpfulness: 3 },
    ]);
  });

  it('ignores linked responses from users without an enrollment anchor', () => {
    const rows = [weeklyRow(99, 1, 'r1')];
    const overview = buildSurveyDataOverview(ENROLLED, rows, NOW);
    expect(overview.weeklyAggregates).toEqual([]);
  });
});
