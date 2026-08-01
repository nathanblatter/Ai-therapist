import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getEvalBucketsMock,
  getRecentDimensionScoresMock,
  insertDriftAlertMock,
  markDriftAlertPagedMock,
  getSystemConfigMock,
  sendCrisisAlertMock,
} = vi.hoisted(() => ({
  getEvalBucketsMock: vi.fn(),
  getRecentDimensionScoresMock: vi.fn(),
  insertDriftAlertMock: vi.fn(),
  markDriftAlertPagedMock: vi.fn(),
  getSystemConfigMock: vi.fn(),
  sendCrisisAlertMock: vi.fn(),
}));

vi.mock('openai', () => ({ default: class {} }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn() }));
vi.mock('../db/index.js', () => ({
  getEvalBuckets: getEvalBucketsMock,
  getRecentDimensionScores: getRecentDimensionScoresMock,
  insertDriftAlert: insertDriftAlertMock,
  markDriftAlertPaged: markDriftAlertPagedMock,
}));
vi.mock('../utils/sessionHelpers.js', () => ({
  getSystemConfig: getSystemConfigMock,
  DEFAULT_MODALITY_PRESETS: {},
}));
vi.mock('./crisisAlert.service.js', () => ({ sendCrisisAlert: sendCrisisAlertMock }));

import { computeDrift, checkEvalDrift } from './evalDrift.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  getSystemConfigMock.mockResolvedValue({ evals: {} });
  insertDriftAlertMock.mockResolvedValue({ alert_id: 99 });
});

describe('computeDrift', () => {
  it('returns null when the window has < minWindow samples', () => {
    expect(computeDrift([5, 5, 5], 20, 100, 10)).toBeNull();
  });

  it('returns null when the baseline has < minWindow samples', () => {
    // 12 window + 3 baseline: window ok (>=10) but baseline short
    const scores = [...new Array(12).fill(3), 5, 5, 5];
    expect(computeDrift(scores, 12, 100, 10)).toBeNull();
  });

  it('computes means on a newest-first split', () => {
    // window = first 2 (mean 3), baseline = next 2 (mean 5) → drop 2
    const d = computeDrift([3, 3, 5, 5], 2, 2, 2)!;
    expect(d.rollingMean).toBeCloseTo(3, 6);
    expect(d.baselineMean).toBeCloseTo(5, 6);
    expect(d.drop).toBeCloseTo(2, 6);
    expect(d.windowN).toBe(2);
    expect(d.baselineN).toBe(2);
  });
});

describe('checkEvalDrift', () => {
  const bucket = { ai_model: 'gpt-4o', prompt_version: 'v1', n: 130 };
  // 20-score window mean 3, 100-score baseline mean 5 → drop 2 (>= 0.5)
  const driftingScores = [...new Array(20).fill(3), ...new Array(100).fill(5)];
  // window mean 5, baseline mean 5 → drop 0
  const stableScores = new Array(120).fill(5);

  it('alerts only when the drop meets the threshold', async () => {
    getEvalBucketsMock.mockResolvedValue([bucket]);
    getRecentDimensionScoresMock.mockImplementation(async (dim: string) =>
      dim === 'empathy' ? driftingScores : stableScores
    );

    const result = await checkEvalDrift();
    expect(result.alerted).toBe(1);
    expect(insertDriftAlertMock).toHaveBeenCalledTimes(1);
    expect(insertDriftAlertMock.mock.calls[0][0]).toMatchObject({
      dimension: 'empathy',
      ai_model: 'gpt-4o',
      prompt_version: 'v1',
      drop_amount: 2,
    });
  });

  it('does not page when an open alert already exists (insert returns null)', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { drift_page_enabled: true } });
    getEvalBucketsMock.mockResolvedValue([bucket]);
    getRecentDimensionScoresMock.mockResolvedValue(driftingScores);
    insertDriftAlertMock.mockResolvedValue(null); // already open

    const result = await checkEvalDrift();
    expect(result.alerted).toBe(0);
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
  });

  it('does not page when drift_page_enabled is false (default)', async () => {
    getEvalBucketsMock.mockResolvedValue([bucket]);
    getRecentDimensionScoresMock.mockImplementation(async (dim: string) =>
      dim === 'empathy' ? driftingScores : stableScores
    );

    await checkEvalDrift();
    expect(sendCrisisAlertMock).not.toHaveBeenCalled();
    expect(markDriftAlertPagedMock).not.toHaveBeenCalled();
  });

  it('pages once through the crisis channel when drift_page_enabled is true', async () => {
    getSystemConfigMock.mockResolvedValue({ evals: { drift_page_enabled: true } });
    getEvalBucketsMock.mockResolvedValue([bucket]);
    getRecentDimensionScoresMock.mockImplementation(async (dim: string) =>
      dim === 'empathy' ? driftingScores : stableScores
    );

    await checkEvalDrift();
    expect(sendCrisisAlertMock).toHaveBeenCalledTimes(1);
    expect(sendCrisisAlertMock.mock.calls[0][0]).toContain('[EVAL DRIFT]');
    expect(markDriftAlertPagedMock).toHaveBeenCalledWith(99);
  });
});
