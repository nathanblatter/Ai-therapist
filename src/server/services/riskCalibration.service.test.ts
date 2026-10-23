// Risk calibration service (eval spec WP3): label rule, P/R/F1 grid and band
// math on hand-computed fixtures, Cohen's kappa + agreement matrix, threshold
// recommendation, seeded stratified sampler determinism, the miss-rate
// estimator with an injected scorer (budget cap, failures, dry run), report
// assembly with insufficient labels, parameter normalisation, and the stored
// run row.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => ({
  getScoredMessages: vi.fn(),
  getAdjudicationCoverage: vi.fn(),
  getUnflaggedCandidates: vi.fn(),
  getRedactedMessageContext: vi.fn(),
  insertRiskCalibrationRun: vi.fn(),
}));
const det = vi.hoisted(() => ({ assessRiskOffline: vi.fn() }));
const org = vi.hoisted(() => ({ getIrbStudyOrgId: vi.fn() }));

vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));
vi.mock('../db/riskCalibration.queries.js', () => ({ ...q, UNFLAGGED_MAX_SCORE: 24 }));
vi.mock('./crisisDetection.service.js', () => det);
vi.mock('../db/organizations.queries.js', () => org);
vi.mock('../utils/gitSha.js', () => ({ gitSha: () => 'abc1234' }));

import {
  labelForVerdicts,
  deriveLabels,
  confusionAt,
  metricsFromConfusion,
  computeMetricsGrid,
  computeBandPerformance,
  cohenKappa,
  computeAgreementMatrix,
  recommendThreshold,
  mulberry32,
  stratifiedSample,
  estimateMissRate,
  assessorCostUsd,
  assembleLabelReport,
  normalizeParams,
  buildRiskCalibrationReport,
  runAndStoreRiskCalibration,
  recommendedThresholdMap,
  THRESHOLD_GRID,
  LAYERS,
  MIN_LABELS_PER_CLASS,
  MISS_RATE_BUDGET_USD,
  type ScoredPair,
  type LabeledSample,
  type LayerKey,
} from './riskCalibration.service.js';
import type { ScoredMessageRow, AdjudicationCoverage, UnflaggedCandidate } from '../db/riskCalibration.queries.js';

const row = (over: Partial<ScoredMessageRow> = {}): ScoredMessageRow => ({
  history_id: 1,
  message_id: 10,
  risk_score: 0,
  method: 'keyword_only',
  keyword_score: 0,
  llm_score: null,
  moderation_self_harm: null,
  moderation_self_harm_intent: null,
  moderation_self_harm_instructions: null,
  moderation_score: null,
  trajectory_score: 0,
  crisis_event_id: null,
  verdicts: [],
  ...over,
});
const coverage = (over: Partial<AdjudicationCoverage> = {}): AdjudicationCoverage => ({
  flagged_events: 0,
  adjudicated_events: 0,
  confirmed: 0,
  false_positive: 0,
  unclear: 0,
  disputed: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  org.getIrbStudyOrgId.mockResolvedValue(1);
  q.getScoredMessages.mockResolvedValue([]);
  q.getAdjudicationCoverage.mockResolvedValue(coverage());
  q.getUnflaggedCandidates.mockResolvedValue([]);
  q.insertRiskCalibrationRun.mockImplementation(async (i: Record<string, unknown>) => ({
    run_id: 7,
    org_id: i.orgId,
    started_at: new Date(i.startedAt as string),
    finished_at: new Date(i.finishedAt as string),
    params: i.params,
    report: i.report,
    recommended_thresholds: i.recommendedThresholds,
    created_by: i.createdBy,
  }));
});

describe('label rule', () => {
  it('maps verdicts to positive / negative / excluded with the reason', () => {
    expect(labelForVerdicts(['confirmed'], true, true)).toEqual({ label: 'positive', reason: 'confirmed' });
    expect(labelForVerdicts(['confirmed', 'confirmed'], true, true)).toEqual({
      label: 'positive',
      reason: 'confirmed',
    });
    expect(labelForVerdicts(['false_positive'], true, true)).toEqual({ label: 'negative', reason: 'false_positive' });
    expect(labelForVerdicts(['unclear'], true, true)).toEqual({ label: 'excluded', reason: 'unclear' });
    expect(labelForVerdicts(['confirmed', 'false_positive'], true, true)).toEqual({
      label: 'excluded',
      reason: 'disputed',
    });
    expect(labelForVerdicts([], true, true)).toEqual({ label: 'excluded', reason: 'unadjudicated' });
  });

  it('treats no-event messages as negative only when the param says so', () => {
    expect(labelForVerdicts([], false, true)).toEqual({ label: 'negative', reason: 'no_event_assumed_negative' });
    expect(labelForVerdicts([], false, false)).toEqual({ label: 'excluded', reason: 'no_event_unlabelled' });
  });

  it('extracts every layer, scaling moderation probabilities to 0..100 and keeping missing LLM scores null', () => {
    const [s] = deriveLabels(
      [
        row({
          risk_score: 62,
          keyword_score: 50,
          llm_score: 55,
          moderation_self_harm: 0.1234,
          moderation_self_harm_intent: 0.5,
          moderation_self_harm_instructions: 0.001,
          moderation_score: 50,
          trajectory_score: 10,
        }),
      ],
      true,
    );
    expect(s.signals).toEqual({
      composite: 62,
      keyword: 50,
      llm: 55,
      moderation_self_harm: 12.34,
      moderation_self_harm_intent: 50,
      moderation_self_harm_instructions: 0.1,
      moderation_composite: 50,
      trajectory: 10,
    });
    expect(deriveLabels([row()], true)[0].signals.llm).toBeNull();
  });
});

describe('precision / recall / F1', () => {
  // Hand-computed fixture: scores 10, 30, 60, 90 positive; 5, 30, 55 negative.
  const pairs: ScoredPair[] = [
    { score: 10, positive: true },
    { score: 30, positive: true },
    { score: 60, positive: true },
    { score: 90, positive: true },
    { score: 5, positive: false },
    { score: 30, positive: false },
    { score: 55, positive: false },
  ];

  it('builds the confusion matrix at a threshold (score >= t is positive)', () => {
    expect(confusionAt(pairs, 50)).toEqual({ tp: 2, fp: 1, fn: 2, tn: 2 });
    expect(confusionAt(pairs, 30)).toEqual({ tp: 3, fp: 2, fn: 1, tn: 1 });
    expect(confusionAt(pairs, 0)).toEqual({ tp: 4, fp: 3, fn: 0, tn: 0 });
  });

  it('computes P/R/F1 by hand at 50: P=2/3, R=2/4, F1=0.5714', () => {
    const m = metricsFromConfusion(50, confusionAt(pairs, 50));
    expect(m.precision).toBe(0.6667);
    expect(m.recall).toBe(0.5);
    expect(m.f1).toBe(0.5714);
  });

  it('reports undefined precision as null above every score, and F1 0 when P and R are both 0', () => {
    expect(metricsFromConfusion(95, confusionAt(pairs, 95))).toMatchObject({
      tp: 0,
      fp: 0,
      fn: 4,
      precision: null,
      recall: 0,
      f1: null,
    });
    expect(metricsFromConfusion(0, { tp: 0, fp: 3, fn: 2, tn: 0 })).toMatchObject({ precision: 0, recall: 0, f1: 0 });
    expect(metricsFromConfusion(0, { tp: 0, fp: 0, fn: 0, tn: 5 })).toMatchObject({
      precision: null,
      recall: null,
      f1: null,
    });
  });

  it('scores the whole grid and the live bands', () => {
    const grid = computeMetricsGrid(pairs);
    expect(grid.map((p) => p.threshold)).toEqual([...THRESHOLD_GRID]);
    expect(grid[0]).toMatchObject({ threshold: 0, precision: 0.5714, recall: 1, f1: 0.7273 });
    const bands = computeBandPerformance(pairs);
    expect(bands.low).toMatchObject({ threshold: 25, tp: 3, fp: 2, precision: 0.6, recall: 0.75 });
    expect(bands.medium.threshold).toBe(50);
    expect(bands.high).toMatchObject({ threshold: 75, tp: 1, fp: 0, precision: 1, recall: 0.25, f1: 0.4 });
  });
});

describe("Cohen's kappa and the agreement matrix", () => {
  it('matches the textbook 2x2 example (po=0.7, pe=0.5 -> kappa 0.4)', () => {
    // a: 20 items; both yes 5, a-only 2, b-only 1, both no 12 ... use a 10-item version:
    // both yes 3, a only 1, b only 2, neither 4 -> po = 0.7, pa = 0.4, pb = 0.5, pe = 0.2 + 0.3 = 0.5
    const a = [true, true, true, true, false, false, false, false, false, false];
    const b = [true, true, true, false, true, true, false, false, false, false];
    expect(cohenKappa(a, b)).toBe(0.4);
  });

  it('is 1 for identical raters, -1 for perfectly opposed, and null when undefined', () => {
    expect(cohenKappa([true, false, true], [true, false, true])).toBe(1);
    expect(cohenKappa([true, false], [false, true])).toBe(-1);
    expect(cohenKappa([true, true], [true, true])).toBeNull();
    expect(cohenKappa([true], [true])).toBeNull();
  });

  it('builds the pairwise matrix over rows where both layers have a value', () => {
    const samples: Array<Pick<LabeledSample, 'signals'>> = [
      { signals: sig({ composite: 80, keyword: 75, llm: 70 }) },
      { signals: sig({ composite: 10, keyword: 0, llm: 5 }) },
      { signals: sig({ composite: 55, keyword: 50, llm: null }) },
      { signals: sig({ composite: 20, keyword: 15, llm: 60 }) },
    ];
    const m = computeAgreementMatrix(samples, ['composite', 'keyword', 'llm']);
    expect(m.layers).toEqual(['composite', 'keyword', 'llm']);
    expect(m.n[0][1]).toBe(4);
    expect(m.n[0][2]).toBe(3);
    expect(m.kappa[0][0]).toBe(1);
    expect(m.kappa[0][1]).toBe(1); // composite and keyword flag the same rows
    expect(m.agreement[0][1]).toBe(1);
    // composite vs llm over 3 rows: (80,70) both yes, (10,5) both no, (20,60) disagree -> po 2/3, pa 1/3, pb 2/3, pe 2/9+2/9=4/9 -> (6/9-4/9)/(5/9) = 0.4
    expect(m.kappa[0][2]).toBe(0.4);
    expect(m.kappa[2][0]).toBe(0.4);
  });
});

function sig(over: Partial<Record<LayerKey, number | null>>): Record<LayerKey, number | null> {
  const base = Object.fromEntries(LAYERS.map((l) => [l.key, null])) as Record<LayerKey, number | null>;
  return { ...base, ...over };
}

describe('threshold recommendation', () => {
  it('picks the F1-maximising threshold, tie-breaking toward the current band', () => {
    const grid = computeMetricsGrid([
      { score: 60, positive: true },
      { score: 70, positive: true },
      { score: 40, positive: false },
      { score: 10, positive: false },
    ]);
    // F1 = 1 at every threshold in (40, 60]; nearest to 50 among 45/50/55/60 is 50.
    const r = recommendThreshold('composite', grid, 50, 4);
    expect(r).toMatchObject({
      layer: 'composite',
      current: 50,
      recommended: 50,
      f1_at_current: 1,
      f1_at_recommended: 1,
      n: 4,
    });
    const r2 = recommendThreshold('composite', grid, 25, 4);
    expect(r2.recommended).toBe(45);
    expect(r2.f1_at_current).toBe(0.8);
  });

  it('returns null when the grid has no defined F1', () => {
    expect(recommendThreshold('llm', [], 50, 0).recommended).toBeNull();
  });
});

describe('seeded stratified sampler', () => {
  const candidates: UnflaggedCandidate[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ message_id: 100 + i, session_id: 'a', stratum: 'chat|scored' })),
    ...Array.from({ length: 60 }, (_, i) => ({ message_id: 200 + i, session_id: 'b', stratum: 'realtime|scored' })),
    ...Array.from({ length: 10 }, (_, i) => ({ message_id: 300 + i, session_id: 'c', stratum: 'realtime|unscored' })),
  ];

  it('is deterministic for a seed and changes with it', () => {
    const a = stratifiedSample(candidates, 20, 42).map((c) => c.message_id);
    const b = stratifiedSample(candidates, 20, 42).map((c) => c.message_id);
    const c = stratifiedSample(candidates, 20, 43).map((c) => c.message_id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(20);
  });

  it('allocates proportionally with largest remainder (30/60/10 of 100 -> 6/12/2 of 20)', () => {
    const s = stratifiedSample(candidates, 20, 1);
    const counts = s.reduce<Record<string, number>>(
      (acc, c) => ({ ...acc, [c.stratum]: (acc[c.stratum] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ 'chat|scored': 6, 'realtime|scored': 12, 'realtime|unscored': 2 });
  });

  it('never exceeds a stratum, returns everything when size >= total, and nothing for size 0', () => {
    expect(stratifiedSample(candidates, 500, 1)).toHaveLength(100);
    expect(stratifiedSample(candidates, 0, 1)).toEqual([]);
    expect(stratifiedSample([], 5, 1)).toEqual([]);
    // 3 of a 3-stratum set: each stratum gets one despite the 10-row stratum rounding to 0.3.
    const three = stratifiedSample(candidates, 3, 9);
    expect(new Set(three.map((c) => c.stratum)).size).toBe(3);
  });

  it('mulberry32 is a reproducible PRNG in [0, 1)', () => {
    const r1 = mulberry32(5);
    const r2 = mulberry32(5);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    expect(seq1).toEqual(seq2);
    for (const v of seq1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('miss-rate estimate', () => {
  const candidates: UnflaggedCandidate[] = Array.from({ length: 10 }, (_, i) => ({
    message_id: i + 1,
    session_id: 's',
    stratum: i < 4 ? 'chat|scored' : 'realtime|scored',
  }));
  const ctx = async (id: number) =>
    id === 3 ? null : { latest: `msg ${id}`, history: [{ role: 'assistant' as const, content_redacted: 'hi' }] };

  it('prices assessor usage with the per-model rate', () => {
    expect(assessorCostUsd('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(assessorCostUsd('unknown-model', 1_000_000, 0)).toBeCloseTo(0.5, 6);
  });

  it('dry run samples and reports ids without calling the scorer', async () => {
    const scorer = vi.fn();
    const r = await estimateMissRate(
      candidates,
      { sample_size: 5, seed: 1, dry_run: true, budget_usd: 0.5 },
      { scorer, contextFor: ctx },
    );
    expect(scorer).not.toHaveBeenCalled();
    expect(r.sampled).toBe(5);
    expect(r.sampled_message_ids).toHaveLength(5);
    expect(r.scored).toBe(0);
    expect(r.fraction_ge_50).toBeNull();
    expect(r.by_stratum.map((s) => [s.stratum, s.candidates, s.sampled])).toEqual([
      ['chat|scored', 4, 2],
      ['realtime|scored', 6, 3],
    ]);
  });

  it('re-scores the sample, counts >= 50 / >= 75, failures and spend', async () => {
    const scorer = vi.fn(async (latest: string) => {
      const id = Number(latest.replace('msg ', ''));
      return { risk_score: id % 2 === 0 ? 80 : 55, model: 'gpt-4o-mini', prompt_tokens: 1000, completion_tokens: 100 };
    });
    const r = await estimateMissRate(
      candidates,
      { sample_size: 10, seed: 1, dry_run: false, budget_usd: 0.5 },
      { scorer, contextFor: ctx, concurrency: 3 },
    );
    expect(r.sampled).toBe(10);
    expect(r.failed).toBe(1); // message 3 has no redacted context
    expect(r.scored).toBe(9);
    expect(r.ge_50).toBe(9);
    expect(r.ge_75).toBe(5); // even ids 2,4,6,8,10
    expect(r.fraction_ge_50).toBe(1);
    expect(r.fraction_ge_75).toBe(0.5556);
    expect(r.prompt_tokens).toBe(9000);
    expect(r.spend_usd).toBeCloseTo((9 * (1000 * 0.15 + 100 * 0.6)) / 1_000_000, 8);
    expect(r.assessor_model).toBe('gpt-4o-mini');
    expect(r.budget_exhausted).toBe(false);
    expect(r.by_stratum.reduce((a, s) => a + s.scored, 0)).toBe(9);
  });

  it('stops at the budget cap and says so', async () => {
    // Each call costs $0.15 (1M prompt tokens): the cap allows 3 of 10.
    const scorer = vi.fn(async () => ({
      risk_score: 10,
      model: 'gpt-4o-mini',
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
    }));
    const r = await estimateMissRate(
      candidates,
      { sample_size: 10, seed: 1, dry_run: false, budget_usd: 0.5 },
      { scorer, contextFor: ctx, concurrency: 1 },
    );
    expect(r.budget_exhausted).toBe(true);
    expect(r.scored).toBe(3);
    expect(r.spend_usd).toBeCloseTo(0.45, 6);
    expect(scorer).toHaveBeenCalledTimes(3);
  });

  it('counts a scorer error as a failure, never as a safe score', async () => {
    const scorer = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await estimateMissRate(
      candidates,
      { sample_size: 2, seed: 1, dry_run: false, budget_usd: 0.5 },
      { scorer, contextFor: ctx },
    );
    expect(r.failed).toBe(2);
    expect(r.scored).toBe(0);
    expect(r.fraction_ge_50).toBeNull();
  });
});

describe('report assembly', () => {
  it('reports insufficient labels with counts and no grids when adjudications are missing (stage today)', () => {
    const rows = [
      row({ history_id: 1, risk_score: 80, crisis_event_id: 5, verdicts: [] }),
      ...Array.from({ length: 20 }, (_, i) =>
        row({ history_id: 10 + i, risk_score: i, keyword_score: i >= 15 ? 50 : 0 }),
      ),
    ];
    const r = assembleLabelReport(rows, coverage({ flagged_events: 1 }), true);
    expect(r.labels).toMatchObject({
      scored_messages: 21,
      with_event: 1,
      positives: 0,
      negatives: 20,
      negatives_assumed_unflagged: 20,
      excluded_unadjudicated: 1,
      insufficient_labels: true,
      min_labels_per_class: MIN_LABELS_PER_CLASS,
    });
    expect(r.layers.every((l) => l.grid.length === 0 && l.bands === null)).toBe(true);
    expect(r.recommendations).toEqual([]);
    // Agreement is still computed from the signals.
    expect(r.agreement.n[0][1]).toBe(21);
    expect(typeof r.agreement.kappa[0][1]).toBe('number');
  });

  it('computes grids, bands and recommendations once each class has enough labels', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        row({
          history_id: 1 + i,
          risk_score: 70 + i,
          llm_score: 65 + i,
          keyword_score: 75,
          crisis_event_id: 100 + i,
          verdicts: ['confirmed'],
        }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        row({
          history_id: 20 + i,
          risk_score: 55,
          llm_score: 50,
          keyword_score: 50,
          crisis_event_id: 200 + i,
          verdicts: ['false_positive'],
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) => row({ history_id: 40 + i, risk_score: i, keyword_score: 0 })),
    ];
    const r = assembleLabelReport(
      rows,
      coverage({ flagged_events: 9, adjudicated_events: 9, confirmed: 6, false_positive: 3 }),
      true,
    );
    expect(r.labels).toMatchObject({
      positives: 6,
      negatives: 13,
      negatives_from_false_positive: 3,
      insufficient_labels: false,
    });
    const composite = r.layers.find((l) => l.key === 'composite')!;
    expect(composite.n).toBe(19);
    expect(composite.grid).toHaveLength(THRESHOLD_GRID.length);
    expect(composite.bands!.high).toMatchObject({ tp: 1, fp: 0, fn: 5 }); // only risk 75 clears the high band
    expect(composite.bands!.medium).toMatchObject({ tp: 6, fp: 3, fn: 0 });
    // LLM layer: only the 9 event rows carry a score -> 6 positives, 3 negatives: not enough negatives.
    const llm = r.layers.find((l) => l.key === 'llm')!;
    expect(llm.n).toBe(9);
    expect(llm.grid).toEqual([]);
    const rec = r.recommendations.find((x) => x.layer === 'composite')!;
    expect(rec.recommended).toBe(60); // every positive >= 70, every negative <= 55: 60 is the F1=1 cut nearest 50
    expect(rec.f1_at_recommended).toBe(1);
  });
});

describe('parameters', () => {
  const now = new Date('2026-10-23T12:00:00Z');

  it('defaults to a 365-day window, 50 samples, the fixed seed and the budget cap', () => {
    const p = normalizeParams({}, now);
    expect(p).toEqual({
      since: '2025-10-23T12:00:00.000Z',
      until: '2026-10-23T12:00:00.000Z',
      sample_size: 50,
      seed: 20261023,
      unflagged_as_negative: true,
      dry_run: false,
      budget_usd: MISS_RATE_BUDGET_USD,
    });
  });

  it('rejects bad windows, sizes and budgets above the cap', () => {
    expect(() => normalizeParams({ since: 'nope' }, now)).toThrow(/since/);
    expect(() => normalizeParams({ since: '2026-11-01', until: '2026-10-01' }, now)).toThrow(/before/);
    expect(() => normalizeParams({ sample_size: 501 }, now)).toThrow(/sample_size/);
    expect(() => normalizeParams({ sample_size: -1 }, now)).toThrow(/sample_size/);
    expect(() => normalizeParams({ budget_usd: 5 }, now)).toThrow(/budget_usd/);
    expect(normalizeParams({ since: '2026-01-01', sample_size: 0, dry_run: true }, now)).toMatchObject({
      since: '2026-01-01T00:00:00.000Z',
      sample_size: 0,
      dry_run: true,
    });
  });
});

describe('build and store', () => {
  it('scopes the window to the org (unattributed only for the irb org) and stores an advisory run row', async () => {
    const params = normalizeParams({ sample_size: 0 }, new Date('2026-10-23T12:00:00Z'));
    const run = await runAndStoreRiskCalibration({ orgId: 1, params, createdBy: 'res1' });
    expect(q.getScoredMessages).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 1, includeUnattributed: true, from: params.since, to: params.until }),
    );
    expect(run.run_id).toBe(7);
    expect(run.created_by).toBe('res1');
    expect(run.recommended_thresholds).toMatchObject({ advisory: true });
    const report = run.report as unknown as {
      labels: { insufficient_labels: boolean };
      advisory: boolean;
      miss_rate: { sampled: number } | null;
    };
    expect(report.advisory).toBe(true);
    expect(report.labels.insufficient_labels).toBe(true);
    expect(report.miss_rate?.sampled).toBe(0);
    expect(det.assessRiskOffline).not.toHaveBeenCalled();

    await buildRiskCalibrationReport({ orgId: 2, params });
    expect(q.getScoredMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ orgId: 2, includeUnattributed: false }),
    );
  });

  it('flattens recommendations into the run row map', () => {
    const report = {
      recommendations: [
        { layer: 'composite', recommended: 60 },
        { layer: 'llm', recommended: null },
      ],
    } as unknown as Parameters<typeof recommendedThresholdMap>[0];
    expect(recommendedThresholdMap(report)).toMatchObject({ advisory: true, composite: 60, llm: null });
  });
});
