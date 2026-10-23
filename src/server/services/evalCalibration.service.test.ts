import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getCalibrationPairsMock, getJudgeRunsMock, getHighDisagreementMock, getHumanRatingPairsMock } = vi.hoisted(
  () => ({
    getCalibrationPairsMock: vi.fn(),
    getJudgeRunsMock: vi.fn(),
    getHighDisagreementMock: vi.fn(),
    getHumanRatingPairsMock: vi.fn(),
  }),
);
vi.mock('../db/index.js', () => ({
  getCalibrationPairs: getCalibrationPairsMock,
  getSessionEvalJudgeRuns: getJudgeRunsMock,
  getHighDisagreementEvals: getHighDisagreementMock,
  getHumanRatingPairs: getHumanRatingPairsMock,
}));

import {
  quadraticWeightedKappa,
  computeCalibrationReport,
  computeJudgeAgreement,
  computeJudgeAgreementReport,
  computeHumanAgreement,
  computeHumanAgreementReport,
  validateHumanRubric,
  CALIBRATION_MIN_PAIRS,
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
    const full = (score: number) => Object.fromEntries(dims.map((d) => [d, { score }]));
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
    expect(report.dimensions.map((d) => d.dimension)).toEqual(dims);
    const empathy = report.dimensions.find((d) => d.dimension === 'empathy')!;
    expect(empathy.n).toBe(5); // one pair skipped
    const safety = report.dimensions.find((d) => d.dimension === 'safety_protocol')!;
    expect(safety.n).toBe(6);
    // mean_bias = llm_mean - human_mean = 5 - 4 = 1 (judge scores higher)
    expect(safety.mean_bias).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// Human-human agreement (eval program WP2)
// ---------------------------------------------------------------------------

describe('computeHumanAgreement', () => {
  const full = (score: number, over: Record<string, number> = {}) =>
    Object.fromEntries(EVAL_DIMENSIONS.map((d) => [d, { score: over[d] ?? score }]));

  it('reports per-dimension kappa, exact and major disagreement, with progress toward 20 sessions', () => {
    // Six double-rated sessions: raters agree exactly on empathy (varying
    // scores), rater b is one point higher on safety everywhere, and on s5
    // they differ by 2 on clinical_claims.
    const empathy = [1, 2, 3, 4, 5, 3];
    const pairs = empathy.map((e, i) => ({
      session_id: `s${i}`,
      rater_a: 1,
      rater_b: 2,
      rubric_a: full(4, { empathy: e, safety_protocol: 3, clinical_claims: i === 5 ? 2 : 4 }),
      rubric_b: full(4, { empathy: e, safety_protocol: 4, clinical_claims: 4 }),
    }));
    const report = computeHumanAgreement(pairs, 'v1');
    expect(report.rubric_version).toBe('v1');
    expect(report.pair_count).toBe(6);
    expect(report.session_count).toBe(6);
    expect(report.target_pairs).toBe(CALIBRATION_MIN_PAIRS);
    expect(report.pairs_needed).toBe(14);
    expect(report.dimensions.map((d) => d.dimension)).toEqual([...EVAL_DIMENSIONS]);
    const emp = report.dimensions.find((d) => d.dimension === 'empathy')!;
    expect(emp.n).toBe(6);
    expect(emp.kappa).toBeCloseTo(1, 6);
    expect(emp.exact_agreement_pct).toBe(100);
    expect(emp.major_disagreement_pct).toBe(0);
    const safety = report.dimensions.find((d) => d.dimension === 'safety_protocol')!;
    expect(safety.exact_agreement_pct).toBe(0);
    expect(safety.kappa).toBeCloseTo(0, 6); // constant offset: no agreement beyond chance
    const claims = report.dimensions.find((d) => d.dimension === 'clinical_claims')!;
    expect(claims.major_disagreement_pct).toBeCloseTo(100 / 6, 6);
  });

  it('counts every unordered rater pair on a triple-rated session and skips invalid scores', () => {
    const pairs = [
      { session_id: 's', rater_a: 1, rater_b: 2, rubric_a: full(3), rubric_b: full(3) },
      { session_id: 's', rater_a: 1, rater_b: 3, rubric_a: full(3), rubric_b: full(3) },
      { session_id: 's', rater_a: 2, rater_b: 3, rubric_a: full(3), rubric_b: { ...full(3), empathy: { score: 9 } } },
    ];
    const report = computeHumanAgreement(pairs, 'v1');
    expect(report.pair_count).toBe(3);
    expect(report.session_count).toBe(1);
    expect(report.dimensions.find((d) => d.dimension === 'empathy')!.n).toBe(2);
    expect(report.dimensions.find((d) => d.dimension === 'safety_protocol')!.n).toBe(3);
  });

  it('is empty-safe', () => {
    const report = computeHumanAgreement([], 'v1');
    expect(report.pair_count).toBe(0);
    expect(report.pairs_needed).toBe(CALIBRATION_MIN_PAIRS);
    expect(report.overall_kappa).toBeNull();
    expect(report.dimensions.every((d) => d.n === 0 && d.kappa === null)).toBe(true);
  });

  it('computeHumanAgreementReport fetches pairs for the current rubric version', async () => {
    getHumanRatingPairsMock.mockResolvedValue([]);
    const report = await computeHumanAgreementReport();
    expect(getHumanRatingPairsMock).toHaveBeenCalledWith('v1');
    expect(report.rubric_version).toBe('v1');
  });
});

describe('validateHumanRubric', () => {
  const good = () => Object.fromEntries([...EVAL_DIMENSIONS].map((d) => [d, { score: 4 }]));

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

// ---------------------------------------------------------------------------
// Judge ensemble agreement (migration 107)
// ---------------------------------------------------------------------------

type JudgeRow = Parameters<typeof computeJudgeAgreement>[0][number];

function judgeRow(session: string, judge: string, scores: Record<string, number>, runIndex = 0): JudgeRow {
  const rubric = Object.fromEntries(EVAL_DIMENSIONS.map((d) => [d, { score: scores[d] ?? 4, rationale: '' }]));
  return {
    eval_judge_id: 0,
    session_id: session,
    prompt_version: 'v1',
    judge_model: judge,
    run_index: runIndex,
    seed: runIndex > 0 ? 1000 + runIndex : null,
    rubric,
    overall_comments: null,
    created_at: new Date(),
  };
}

describe('computeJudgeAgreement', () => {
  it('reports per-dimension kappa, exact agreement, bias and major disagreement for each judge pair', () => {
    const rows: JudgeRow[] = [];
    // Six shared sessions: judges agree on empathy exactly, b scores
    // safety_protocol one point higher everywhere, and on session s5 they
    // differ by 2 on clinical_claims.
    const empathy = [1, 2, 3, 4, 5, 3];
    empathy.forEach((e, i) => {
      rows.push(judgeRow(`s${i}`, 'gpt-4o-mini', { empathy: e, safety_protocol: 3, clinical_claims: i === 5 ? 2 : 4 }));
      rows.push(judgeRow(`s${i}`, 'gpt-5-mini', { empathy: e, safety_protocol: 4, clinical_claims: 4 }));
    });
    // One session judged by the first judge only: excluded from pair stats.
    rows.push(judgeRow('lonely', 'gpt-4o-mini', { empathy: 5 }));

    const report = computeJudgeAgreement(rows, 'v1');

    expect(report.judges).toEqual(['gpt-4o-mini', 'gpt-5-mini']);
    expect(report.session_count).toBe(7);
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0];
    expect(pair.n).toBe(6);
    expect(pair.dimensions.map((d) => d.dimension)).toEqual([...EVAL_DIMENSIONS]);

    const emp = pair.dimensions.find((d) => d.dimension === 'empathy')!;
    expect(emp.n).toBe(6);
    expect(emp.kappa).toBeCloseTo(1, 6);
    expect(emp.exact_agreement_pct).toBe(100);
    expect(emp.mean_bias).toBe(0);
    expect(emp.major_disagreement_pct).toBe(0);

    const safety = pair.dimensions.find((d) => d.dimension === 'safety_protocol')!;
    expect(safety.kappa).toBeCloseTo(0, 6); // a constant 3, b constant 4: observed == expected disagreement
    expect(safety.exact_agreement_pct).toBe(0);
    expect(safety.mean_bias).toBeCloseTo(1, 6);

    const claims = pair.dimensions.find((d) => d.dimension === 'clinical_claims')!;
    expect(claims.major_disagreement_pct).toBeCloseTo(100 / 6, 6);
    expect(report.self_consistency).toEqual([]); // single run per judge
  });

  it('reduces self-consistency runs to a per-judge median before pairing and reports run spread', () => {
    const rows: JudgeRow[] = [];
    for (let i = 0; i < 5; i++) {
      // judge a: three runs scoring 3/5/4 on empathy -> median 4; identical elsewhere.
      rows.push(judgeRow(`s${i}`, 'a', { empathy: 3 }, 0));
      rows.push(judgeRow(`s${i}`, 'a', { empathy: 5 }, 1));
      rows.push(judgeRow(`s${i}`, 'a', { empathy: 4 }, 2));
      rows.push(judgeRow(`s${i}`, 'b', { empathy: 4 }, 0));
    }
    const report = computeJudgeAgreement(rows, 'v1');

    const emp = report.pairs[0].dimensions.find((d) => d.dimension === 'empathy')!;
    expect(emp.exact_agreement_pct).toBe(100); // median(3,5,4)=4 == b's 4
    expect(emp.mean_bias).toBe(0);

    expect(report.self_consistency).toHaveLength(1);
    const sc = report.self_consistency[0];
    expect(sc.judge_model).toBe('a');
    expect(sc.runs).toBe(3);
    expect(sc.n).toBe(5);
    const scEmp = sc.dimensions.find((d) => d.dimension === 'empathy')!;
    expect(scEmp.exact_pct).toBe(0);
    expect(scEmp.mean_spread).toBe(2);
    const scSafety = sc.dimensions.find((d) => d.dimension === 'safety_protocol')!;
    expect(scSafety.exact_pct).toBe(100);
    expect(scSafety.mean_spread).toBe(0);
  });

  it('is empty-safe and passes high-disagreement rows through with their max spread', () => {
    const report = computeJudgeAgreement([], 'v1', [
      { session_id: 'x', judge_spread: { empathy: 2, safety_protocol: 0 } },
    ]);
    expect(report.judges).toEqual([]);
    expect(report.pairs).toEqual([]);
    expect(report.session_count).toBe(0);
    expect(report.high_disagreement).toEqual([
      { session_id: 'x', max_spread: 2, judge_spread: { empathy: 2, safety_protocol: 0 } },
    ]);
  });

  it('computeJudgeAgreementReport reads runs + high-disagreement rows for the prompt version', async () => {
    getJudgeRunsMock.mockResolvedValue([judgeRow('s1', 'a', {}), judgeRow('s1', 'b', {})]);
    getHighDisagreementMock.mockResolvedValue([]);
    const report = await computeJudgeAgreementReport('v1');
    expect(getJudgeRunsMock).toHaveBeenCalledWith('v1');
    expect(getHighDisagreementMock).toHaveBeenCalledWith('v1', 10);
    expect(report.pairs[0]).toMatchObject({ judge_a: 'a', judge_b: 'b', n: 1 });
    expect(report.pairs[0].dimensions[0].kappa).toBeNull(); // n < 5
  });
});
