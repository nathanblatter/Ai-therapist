// Table-driven edge cases for the descriptive PHQ-2 / GAD-2 trend rules
// (utils/screenerTrend.ts). Each case is a series of [daysAgo, score] pairs,
// oldest first unless the case is specifically about ordering.
import { describe, it, expect } from 'vitest';
import {
  evaluateScreenerTrend,
  describeObservation,
  MAX_GAP_DAYS,
  RECENCY_DAYS,
  type ScreenerReading,
  type TrendScale,
} from './screenerTrend.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function series(points: [number, number][]): ScreenerReading[] {
  return points.map(([daysAgo, score], i) => ({
    responseId: i + 1,
    score,
    administeredAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
  }));
}

interface Case {
  name: string;
  points: [number, number][];
  scale?: TrendScale;
  expected: Record<string, unknown>;
}

const CASES: Case[] = [
  // --- insufficient data -------------------------------------------------
  {
    name: 'no readings',
    points: [],
    expected: { status: 'insufficient_data', reason: 'no_valid_readings' },
  },
  {
    name: 'single reading below the cutoff counts as recovered (it can only clear, never raise)',
    points: [[1, 1]],
    expected: { status: 'recovered', latestScore: 1 },
  },
  {
    name: 'single reading at the cutoff never flags (no trajectory yet)',
    points: [[1, 5]],
    expected: { status: 'insufficient_data', reason: 'too_few_points' },
  },
  {
    name: 'stale latest reading neither flags nor recovers',
    points: [
      [RECENCY_DAYS + 14, 1],
      [RECENCY_DAYS + 7, 2],
      [RECENCY_DAYS + 1, 5],
    ],
    expected: { status: 'insufficient_data', reason: 'stale' },
  },
  {
    name: 'a gap longer than MAX_GAP_DAYS breaks the run: a cross over the gap is not compared',
    points: [
      [MAX_GAP_DAYS + 10, 1],
      [1, 4],
    ],
    expected: { status: 'insufficient_data', reason: 'too_few_points' },
  },
  // --- R1 cutoff_crossed -------------------------------------------------
  {
    name: 'crosses the cutoff from below between two readings',
    points: [
      [8, 2],
      [1, 4],
    ],
    expected: { status: 'worsening', rules: ['cutoff_crossed'], scores: [2, 4], fromScore: 2, toScore: 4 },
  },
  {
    name: 'landing exactly on the cutoff (2 -> 3) counts as crossing',
    points: [
      [8, 2],
      [1, 3],
    ],
    expected: { status: 'worsening', rules: ['cutoff_crossed'], scores: [2, 3] },
  },
  {
    name: 'a large jump that stays below the cutoff (0 -> 2) is not a crossing',
    points: [
      [8, 0],
      [1, 2],
    ],
    expected: { status: 'no_change', latestScore: 2 },
  },
  {
    name: 'already above the cutoff and rising once (3 -> 5) is a level, not a crossing',
    points: [
      [8, 3],
      [1, 5],
    ],
    expected: { status: 'no_change', latestScore: 5 },
  },
  {
    name: 'crossing uses only the immediately previous reading (4, 2, 3)',
    points: [
      [15, 4],
      [8, 2],
      [1, 3],
    ],
    expected: { status: 'worsening', rules: ['cutoff_crossed'], scores: [2, 3] },
  },
  {
    name: 'a gap exactly at MAX_GAP_DAYS still compares',
    points: [
      [MAX_GAP_DAYS + 1, 1],
      [1, 3],
    ],
    expected: { status: 'worsening', rules: ['cutoff_crossed'] },
  },
  // --- R2 sustained_increase ---------------------------------------------
  {
    name: 'three strictly rising readings below the cutoff',
    points: [
      [15, 0],
      [8, 1],
      [1, 2],
    ],
    expected: { status: 'worsening', rules: ['sustained_increase'], scores: [0, 1, 2], fromScore: 0, toScore: 2 },
  },
  {
    name: 'three rising readings that also cross the cutoff fire both rules',
    points: [
      [15, 1],
      [8, 2],
      [1, 4],
    ],
    expected: { status: 'worsening', rules: ['cutoff_crossed', 'sustained_increase'], scores: [1, 2, 4] },
  },
  {
    name: 'three rising readings above the cutoff (3, 4, 6)',
    points: [
      [15, 3],
      [8, 4],
      [1, 6],
    ],
    expected: { status: 'worsening', rules: ['sustained_increase'], scores: [3, 4, 6] },
  },
  {
    name: 'a plateau is not sustained (1, 2, 2)',
    points: [
      [15, 1],
      [8, 2],
      [1, 2],
    ],
    expected: { status: 'recovered', latestScore: 2 },
  },
  {
    name: 'a single one-point rise does not flag (1, 2)',
    points: [
      [8, 1],
      [1, 2],
    ],
    expected: { status: 'no_change', latestScore: 2 },
  },
  {
    name: 'only the last three readings matter (0, 1, 2, then 1)',
    points: [
      [22, 0],
      [15, 1],
      [8, 2],
      [1, 1],
    ],
    expected: { status: 'recovered', latestScore: 1 },
  },
  {
    name: 'a gap inside the window shortens the run to two (0 | gap | 1, 2)',
    points: [
      [MAX_GAP_DAYS + 20, 0],
      [8, 1],
      [1, 2],
    ],
    expected: { status: 'no_change', latestScore: 2 },
  },
  // --- recovery / no change ----------------------------------------------
  {
    name: 'back under the cutoff and falling (4 -> 2) is recovered',
    points: [
      [8, 4],
      [1, 2],
    ],
    expected: { status: 'recovered', latestScore: 2 },
  },
  {
    name: 'falling but still at/above the cutoff (5 -> 3) is not recovered',
    points: [
      [8, 5],
      [1, 3],
    ],
    expected: { status: 'no_change', latestScore: 3 },
  },
  {
    name: 'stable below the cutoff (1 -> 1) is recovered',
    points: [
      [8, 1],
      [1, 1],
    ],
    expected: { status: 'recovered', latestScore: 1 },
  },
  // --- GAD-2 uses the same rules -----------------------------------------
  {
    name: 'GAD-2 crossing',
    scale: 'gad2',
    points: [
      [8, 1],
      [1, 3],
    ],
    expected: { status: 'worsening', rules: ['cutoff_crossed'], scores: [1, 3] },
  },
];

describe('evaluateScreenerTrend', () => {
  it.each(CASES)('$name', ({ points, scale, expected }) => {
    const result = evaluateScreenerTrend(scale ?? 'phq2', series(points), NOW);
    expect(result).toMatchObject(expected);
  });

  it('orders readings by administration time, not input order', () => {
    const readings = series([
      [1, 4],
      [8, 2],
    ]);
    expect(evaluateScreenerTrend('phq2', readings, NOW)).toMatchObject({
      status: 'worsening',
      scores: [2, 4],
      latestResponseId: 1,
    });
  });

  it('breaks same-timestamp ties by response id', () => {
    const at = new Date(NOW.getTime() - DAY_MS);
    const earlier = new Date(NOW.getTime() - 8 * DAY_MS);
    const result = evaluateScreenerTrend(
      'phq2',
      [
        { responseId: 3, score: 4, administeredAt: at },
        { responseId: 2, score: 1, administeredAt: at },
        { responseId: 1, score: 0, administeredAt: earlier },
      ],
      NOW,
    );
    expect(result).toMatchObject({ status: 'worsening', scores: [0, 1, 4], latestResponseId: 3 });
  });

  it.each([
    ['above the scale maximum', 7],
    ['negative', -1],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
  ])('drops a %s score and reports it', (_label, bad) => {
    const readings = [...series([[8, 2]]), { responseId: 99, score: bad, administeredAt: NOW }];
    const result = evaluateScreenerTrend('phq2', readings, NOW);
    // The invalid reading must not act as the "latest" crossing reading.
    expect(result).toMatchObject({ status: 'recovered', latestScore: 2, droppedInvalid: 1 });
  });

  it('drops an unparseable timestamp', () => {
    const readings = [...series([[8, 2]]), { responseId: 99, score: 5, administeredAt: 'not a date' }];
    expect(evaluateScreenerTrend('phq2', readings, NOW)).toMatchObject({ status: 'recovered', droppedInvalid: 1 });
  });

  it('accepts ISO string timestamps (what the DB layer returns)', () => {
    const readings = series([
      [8, 2],
      [1, 4],
    ]).map((r) => ({ ...r, administeredAt: (r.administeredAt as Date).toISOString() }));
    expect(evaluateScreenerTrend('phq2', readings, NOW)).toMatchObject({ status: 'worsening' });
  });

  it('is pure: the input array is not reordered', () => {
    const readings = series([
      [1, 4],
      [8, 2],
    ]);
    const before = readings.map((r) => r.responseId);
    evaluateScreenerTrend('phq2', readings, NOW);
    expect(readings.map((r) => r.responseId)).toEqual(before);
  });
});

describe('describeObservation (descriptive copy only)', () => {
  it('describes a crossing in observed terms', () => {
    expect(describeObservation('phq2', [2, 4], ['cutoff_crossed'])).toBe(
      'PHQ-2 rose from 2 to 4 across the last two administrations. ' +
        'The latest score is at or above the standard screening cutoff of 3.',
    );
  });

  it('describes a sustained increase with every score', () => {
    expect(describeObservation('gad2', [0, 1, 2], ['sustained_increase'])).toBe(
      'GAD-2 rose from 0 to 2 across the last three administrations (0, 1, 2).',
    );
  });

  it.each([
    [[2, 4], ['cutoff_crossed']],
    [
      [1, 2, 4],
      ['cutoff_crossed', 'sustained_increase'],
    ],
    [[0, 1, 2], ['sustained_increase']],
  ] as const)('never uses predictive or diagnostic language (%j)', (scores, rules) => {
    const text = describeObservation('phq2', [...scores], [...rules]).toLowerCase();
    for (const word of ['risk', 'predict', 'likely', 'diagnos', 'crisis', 'suicid', 'depressed', 'disorder']) {
      expect(text).not.toContain(word);
    }
  });
});
