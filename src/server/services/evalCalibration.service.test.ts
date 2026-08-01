import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getCalibrationPairsMock } = vi.hoisted(() => ({ getCalibrationPairsMock: vi.fn() }));
vi.mock('../db/index.js', () => ({ getCalibrationPairs: getCalibrationPairsMock }));

import {
  quadraticWeightedKappa,
  computeCalibrationReport,
  validateHumanRubric,
} from './evalCalibration.service.js';
import { EVAL_DIMENSIONS } from './sessionEval.service.js';

beforeEach(() => getCalibrationPairsMock.mockReset());

describe('quadraticWeightedKappa', () => {
  it('is 1 for identical arrays', () => {
    expect(quadraticWeightedKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeCloseTo(1, 6);
  });

  it('is -1 for a perfect reversal with uniform marginals', () => {
    expect(quadraticWeightedKappa([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('is near 0 for independent-looking data', () => {
    const a = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
    const b = [3, 3, 3, 3, 3, 2, 4, 2, 4, 3];
    const k = quadraticWeightedKappa(a, b);
    expect(k).not.toBeNull();
    expect(Math.abs(k!)).toBeLessThan(0.4);
  });

  it('returns null when n < minN', () => {
    expect(quadraticWeightedKappa([1, 2, 3], [3, 2, 1])).toBeNull();
  });

  it('returns null when both raters are constant on the same value (denominator 0)', () => {
    expect(quadraticWeightedKappa([4, 4, 4, 4, 4], [4, 4, 4, 4, 4])).toBeNull();
  });
});

describe('computeCalibrationReport', () => {
  it('skips a dimension pair when one side is missing that key', async () => {
    const dims = [...EVAL_DIMENSIONS];
    const full = (score: number) => Object.fromEntries(dims.map(d => [d, { score }]));
    const pairs = Array.from({ length: 6 }, (_, i) => {
      const human = full(4);
      const llm = full(5);
      // Drop empathy from the human rubric of the first pair only.
      if (i === 0) delete (human as Record<string, unknown>).empathy;
      return { session_id: `s${i}`, rater_user_id: 1, human_rubric: human, llm_rubric: llm, prompt_version: 'v1' };
    });
    getCalibrationPairsMock.mockResolvedValue(pairs);

    const report = await computeCalibrationReport('v1');
    expect(report.pair_count).toBe(6);
    expect(report.session_count).toBe(6);
    // dimensions preserve EVAL_DIMENSIONS order
    expect(report.dimensions.map(d => d.dimension)).toEqual(dims);
    const empathy = report.dimensions.find(d => d.dimension === 'empathy')!;
    expect(empathy.n).toBe(5); // one pair skipped
    const safety = report.dimensions.find(d => d.dimension === 'safety_protocol')!;
    expect(safety.n).toBe(6);
    // mean_bias = llm_mean - human_mean = 5 - 4 = 1 (judge scores higher)
    expect(safety.mean_bias).toBeCloseTo(1, 6);
  });
});

describe('validateHumanRubric', () => {
  const good = () => Object.fromEntries([...EVAL_DIMENSIONS].map(d => [d, { score: 4 }]));

  it('accepts a well-formed rubric', () => {
    const r = validateHumanRubric({ rubric: good(), overall_notes: 'ok' });
    expect(r.ok).toBe(true);
    expect(r.overallNotes).toBe('ok');
  });

  it('rejects a rubric missing a key', () => {
    const rubric = good();
    delete (rubric as Record<string, unknown>).empathy;
    expect(validateHumanRubric({ rubric }).ok).toBe(false);
  });

  it('rejects an extra key', () => {
    const rubric = { ...good(), extra: { score: 3 } };
    expect(validateHumanRubric({ rubric }).ok).toBe(false);
  });

  it('rejects out-of-range or non-integer scores', () => {
    expect(validateHumanRubric({ rubric: { ...good(), empathy: { score: 6 } } }).ok).toBe(false);
    expect(validateHumanRubric({ rubric: { ...good(), empathy: { score: 3.5 } } }).ok).toBe(false);
  });

  it('rejects overly long overall_notes', () => {
    expect(validateHumanRubric({ rubric: good(), overall_notes: 'a'.repeat(4001) }).ok).toBe(false);
  });

  it('keeps notes and trims them', () => {
    const r = validateHumanRubric({ rubric: { ...good(), empathy: { score: 4, note: '  strong  ' } } });
    expect(r.ok).toBe(true);
    expect(r.rubric!.empathy.note).toBe('strong');
  });
});
