// Instrument scoring: PHQ-2/GAD-2 sums with the raw-1 offset, the >=3
// cutoff, refusal to score partial/out-of-range payloads, and the weekly
// metric extraction (incl. the helpfulness "did not use" sentinel).
import { describe, it, expect } from 'vitest';
import { scoreInstruments, weeklyMetrics } from './qualtricsScoring.service.js';

describe('scoreInstruments', () => {
  it('scores baseline PHQ-2/GAD-2 with the raw-1 offset and cutoff', () => {
    const result = scoreInstruments('baseline', {
      QID21_1: 4, // 3
      QID21_2: 2, // 1
      QID22_1: 1, // 0
      QID22_2: 2, // 1
    });
    expect(result).toEqual({ phq2: 4, gad2: 1, phq2Positive: true, gad2Positive: false });
  });

  it('scores the exact cutoff (3) as positive', () => {
    const result = scoreInstruments('exit', { QID4_1: 2, QID4_2: 3, QID5_1: 1, QID5_2: 1 });
    expect(result.phq2).toBe(3);
    expect(result.phq2Positive).toBe(true);
    expect(result.gad2).toBe(0);
  });

  it('splits the combined week-12 matrix into PHQ items 1-2 and GAD items 3-4', () => {
    const result = scoreInstruments('week12', { QID6_1: 1, QID6_2: 1, QID6_3: 4, QID6_4: 4 });
    expect(result).toEqual({ phq2: 0, gad2: 6, phq2Positive: false, gad2Positive: true });
  });

  it('returns nulls when any item is missing or out of range', () => {
    expect(scoreInstruments('baseline', { QID21_1: 2, QID22_1: 1, QID22_2: 1 }).phq2).toBeNull();
    expect(scoreInstruments('baseline', { QID21_1: 5, QID21_2: 1 }).phq2).toBeNull();
    expect(scoreInstruments('baseline', { QID21_1: '2', QID21_2: 1 } as never).phq2).toBeNull();
  });

  it('has no instrument for weekly check-ins', () => {
    expect(scoreInstruments('weekly', { QID8: 4 })).toEqual({
      phq2: null,
      gad2: null,
      phq2Positive: null,
      gad2Positive: null,
    });
  });
});

const NULL_ALLIANCE = {
  allianceTask: null,
  allianceBond: null,
  allianceGoal: null,
  allianceTotal: null,
};

describe('weeklyMetrics', () => {
  it('extracts mood, stress, helpfulness, and the usage bucket', () => {
    expect(weeklyMetrics({ QID8: 5, QID9: 2, QID6: 4, QID4: 3 })).toEqual({
      mood: 5,
      stress: 2,
      helpfulness: 4,
      usage: '2-3',
      ...NULL_ALLIANCE,
    });
  });

  it('treats helpfulness choice 6 (did not use) as null', () => {
    expect(weeklyMetrics({ QID6: 6 }).helpfulness).toBeNull();
  });

  it('nulls everything on an empty payload', () => {
    expect(weeklyMetrics({})).toEqual({
      mood: null,
      stress: null,
      helpfulness: null,
      usage: null,
      ...NULL_ALLIANCE,
    });
  });

  it('scores alliance subscales as item means and total as the 6-item mean', () => {
    const result = weeklyMetrics({
      QID7_1: 5, // Bond
      QID7_2: 4, // Bond
      QID7_3: 3, // Goal
      QID7_4: 2, // Task
      QID7_5: 3, // Task
      QID7_6: 4, // Goal
    });
    expect(result.allianceBond).toBe(4.5);
    expect(result.allianceGoal).toBe(3.5);
    expect(result.allianceTask).toBe(2.5);
    expect(result.allianceTotal).toBe(3.5);
  });

  it('nulls a subscale when either item is missing or out of range, and total when any subscale is null', () => {
    const partial = weeklyMetrics({ QID7_1: 5, QID7_2: 4, QID7_3: 3, QID7_4: 6, QID7_5: 3, QID7_6: 4 });
    expect(partial.allianceBond).toBe(4.5);
    expect(partial.allianceTask).toBeNull(); // QID7_4 out of range
    expect(partial.allianceTotal).toBeNull();
  });
});
