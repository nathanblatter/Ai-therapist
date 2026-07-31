import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  estimateCostUsd,
  recordLlmUsage,
  getSessionCostSummary,
  getCostTotals,
} from './costTracking.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('estimateCostUsd', () => {
  it('applies the known rate for a listed model', () => {
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out
    const cost = estimateCostUsd('gpt-4o-mini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it('falls back to the default rate for an unlisted model', () => {
    const cost = estimateCostUsd('some-future-model', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it('treats null token counts as zero', () => {
    expect(estimateCostUsd('gpt-4o-mini', null, null)).toBe(0);
  });
});

describe('recordLlmUsage', () => {
  it('inserts a row and never throws when the query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(recordLlmUsage('sess-1', 'crisis', 'gpt-4o-mini', 100, 50)).resolves.toBeUndefined();
  });

  it('passes the expected params on success', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await recordLlmUsage('sess-1', 'insights', 'gpt-4o-mini', 100, 50);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO session_llm_usage'),
      ['sess-1', 'insights', 'gpt-4o-mini', 100, 50]
    );
  });
});

describe('getSessionCostSummary', () => {
  it('aggregates calls by purpose and sums tokens/cost', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ minutes: 12.3 }] })
      .mockResolvedValueOnce({
        rows: [
          { purpose: 'crisis', model: 'gpt-4o-mini', tokens_in: 1000, tokens_out: 200 },
          { purpose: 'crisis', model: 'gpt-4o-mini', tokens_in: 500, tokens_out: 100 },
          { purpose: 'redaction', model: 'gpt-5', tokens_in: null, tokens_out: null },
        ],
      });

    const summary = await getSessionCostSummary('sess-1');

    expect(summary.realtime_minutes).toBe(12.3);
    expect(summary.calls_by_purpose).toEqual({ insights: 0, redaction: 1, crisis: 2 });
    expect(summary.tokens_in).toBe(1500);
    expect(summary.tokens_out).toBe(300);
    expect(summary.estimated_cost_usd).toBeGreaterThan(0);
  });

  it('returns null realtime_minutes when the session has no duration row', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const summary = await getSessionCostSummary('sess-missing');
    expect(summary.realtime_minutes).toBeNull();
    expect(summary.calls_by_purpose).toEqual({ insights: 0, redaction: 0, crisis: 0 });
  });
});

describe('getCostTotals', () => {
  it('sums usage across purposes and realtime minutes across sessions', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { purpose: 'insights', model: 'gpt-4o-mini', calls: '3', tokens_in: '3000', tokens_out: '900' },
          { purpose: 'crisis', model: 'gpt-4o-mini', calls: '1', tokens_in: '500', tokens_out: '100' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total_minutes: 456.7 }] });

    const totals = await getCostTotals();

    expect(totals.total_calls).toBe(4);
    expect(totals.total_tokens_in).toBe(3500);
    expect(totals.total_tokens_out).toBe(1000);
    expect(totals.total_realtime_minutes).toBe(456.7);
    expect(totals.total_estimated_cost_usd).toBeGreaterThan(0);
  });
});
