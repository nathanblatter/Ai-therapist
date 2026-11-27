// The shadow evaluation's scoring: bands against the acceptable range, the
// three confusion tables, and that a row without an answer is an error, not a
// "none".
import { describe, it, expect } from 'vitest';
import type { DetectorRow } from './schema.js';
import {
  formatShadowEvalMarkdown,
  scoreShadowRows,
  summarizeShadowEval,
  type ProductionBaselineRow,
  type ShadowEvalAnswer,
} from './shadowEvalReport.js';

function row(
  id: string,
  band: DetectorRow['expected']['band'],
  page: DetectorRow['expected']['page'],
  extra: Partial<DetectorRow['expected']> = {},
): DetectorRow {
  return {
    id,
    input: `input for ${id}`,
    history: [],
    modality: 'chat',
    expected: { band, page, ...extra },
    category: band === 'high' ? 'explicit-intent' : 'ordinary-sadness',
    catalogueIds: [],
    source: 'synthetic',
    rationale: 'a test row for the report',
    reviewedBy: null,
    reviewedAt: null,
  };
}

function answer(id: string, band: ShadowEvalAnswer['band'], pHigh = band === 'high' ? 0.9 : 0.01): ShadowEvalAnswer {
  return {
    id,
    band,
    severityProbabilities: band ? { none: 0, low: 0, moderate: 0, high: pHigh } : null,
    predicates: band ? { figure_of_speech: 0.5 } : null,
    latencyMs: 200,
    tokensIn: 3000,
    ...(band ? {} : { error: 'refused: severity' }),
  };
}

const ROWS = [
  row('det-a', 'high', 'yes'),
  row('det-b', 'high', 'yes'),
  row('det-c', 'none', 'no'),
  row('det-d', 'none', 'no'),
  row('det-e', 'moderate', 'either', { acceptableBands: ['moderate', 'high'] }),
];
const ANSWERS = new Map(
  [
    answer('det-a', 'high'),
    answer('det-b', null),
    answer('det-c', 'none'),
    answer('det-d', 'high'),
    answer('det-e', 'high'),
  ].map((a) => [a.id, a]),
);
const PRODUCTION = new Map<string, ProductionBaselineRow>(
  [
    { id: 'det-a', observedBand: 'high' as const, paged: true },
    { id: 'det-b', observedBand: 'high' as const, paged: true },
    { id: 'det-c', observedBand: 'moderate' as const, paged: false },
    { id: 'det-d', observedBand: 'none' as const, paged: false },
    { id: 'det-e', observedBand: 'low' as const, paged: false },
  ].map((p) => [p.id, p]),
);

describe('shadow eval report', () => {
  const scored = scoreShadowRows(ROWS, ANSWERS, PRODUCTION);
  const summary = summarizeShadowEval(scored, ANSWERS, true);

  it('counts a row without an answer as an error, never as none', () => {
    expect(summary.shadowVsExpected.high).toEqual({ none: 0, low: 0, moderate: 0, high: 1, error: 1 });
    expect(summary.shadow.errored).toBe(1);
    expect(summary.shadow.mustPage).toEqual({ n: 2, high: 1, missed: ['det-b'] });
    expect(scored.find((r) => r.id === 'det-b')).toMatchObject({ shadowBand: null, shadowOk: false });
  });

  it('accepts any band in the acceptable range', () => {
    expect(scored.find((r) => r.id === 'det-e')).toMatchObject({ shadowOk: true, productionOk: false });
    expect(summary.shadow.bandOk).toBe(3);
    expect(summary.production?.bandOk).toBe(3);
  });

  it('counts false highs on rows that must not page, and flags on none rows', () => {
    expect(summary.shadow.mustNotPage).toEqual({ n: 2, high: 1, ids: ['det-d'] });
    expect(summary.shadow.noneRows).toEqual({ n: 2, flagged: 1 });
    expect(summary.production?.noneRows).toEqual({ n: 2, flagged: 1 });
  });

  it('builds the production-by-shadow table over rows both sides scored', () => {
    expect(summary.shadowVsProduction?.high).toEqual({ none: 0, low: 0, moderate: 0, high: 1, error: 1 });
    expect(summary.agreement).toEqual({ n: 4, same: 1, rate: 0.25, shadowHigher: 2, shadowLower: 1 });
  });

  it('lists who was right where they differ', () => {
    expect(summary.productionRightShadowWrong).toEqual(['det-b', 'det-d']);
    expect(summary.shadowRightProductionWrong).toEqual(['det-c', 'det-e']);
    expect(summary.bothWrong).toEqual([]);
  });

  it('renders the three tables and the lists', () => {
    const md = formatShadowEvalMarkdown(summary, scored, ['header line']);
    expect(md).toContain('### Shadow severity vs expected band');
    expect(md).toContain('### Production detector vs expected band (committed baseline)');
    expect(md).toContain('### Shadow severity vs production detector');
    expect(md).toContain('## Production right, shadow wrong (2)');
    expect(md).toContain('| det-b | high, page yes | error | n/a | high, paged |');
  });

  it('works without a production baseline', () => {
    const alone = summarizeShadowEval(scoreShadowRows(ROWS, ANSWERS, null), ANSWERS, false);
    expect(alone.production).toBeNull();
    expect(alone.shadowVsProduction).toBeNull();
    expect(alone.shadow.bandOk).toBe(3);
  });
});
