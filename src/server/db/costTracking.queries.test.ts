import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  estimateCostUsd,
  estimateRealtimeCostUsd,
  insertRealtimeUsage,
  recordLlmUsage,
  getSessionCostSummary,
  getCostTotals,
  getDailySpend,
} from './costTracking.queries.js';

const EMPTY_REALTIME_ROLLUP = {
  rows: [{
    responses: '0', input_tokens: '0', output_tokens: '0',
    input_audio_tokens: '0', output_audio_tokens: '0', cached_tokens: '0',
  }],
};

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
      })
      .mockResolvedValueOnce({
        rows: [{
          responses: '4', input_tokens: '1000000', output_tokens: '500000',
          input_audio_tokens: '500000', output_audio_tokens: '250000', cached_tokens: '0',
        }],
      });

    const summary = await getSessionCostSummary('sess-1');

    expect(summary.realtime_minutes).toBe(12.3);
    expect(summary.calls_by_purpose).toEqual({ insights: 0, redaction: 1, crisis: 2, eligibility: 0, rerank: 0, chat: 0 });
    expect(summary.tokens_in).toBe(1500);
    expect(summary.tokens_out).toBe(300);
    expect(summary.estimated_cost_usd).toBeGreaterThan(0);
    expect(summary.realtime_responses).toBe(4);
    // 0.5M text-in*$4 + 0.5M audio-in*$32 + 0.25M text-out*$16 + 0.25M audio-out*$64
    expect(summary.realtime_cost_usd).toBeCloseTo(2 + 16 + 4 + 16, 4);
  });

  it('returns null realtime_minutes when the session has no duration row', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(EMPTY_REALTIME_ROLLUP);

    const summary = await getSessionCostSummary('sess-missing');
    expect(summary.realtime_minutes).toBeNull();
    expect(summary.calls_by_purpose).toEqual({ insights: 0, redaction: 0, crisis: 0, eligibility: 0, rerank: 0, chat: 0 });
    expect(summary.realtime_responses).toBe(0);
    expect(summary.realtime_cost_usd).toBe(0);
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
      .mockResolvedValueOnce({ rows: [{ total_minutes: 456.7 }] })
      .mockResolvedValueOnce({
        rows: [{
          responses: '10', input_tokens: '2000000', output_tokens: '1000000',
          input_audio_tokens: '1000000', output_audio_tokens: '500000', cached_tokens: '1000000',
        }],
      });

    const totals = await getCostTotals();

    expect(totals.total_calls).toBe(4);
    expect(totals.total_tokens_in).toBe(3500);
    expect(totals.total_tokens_out).toBe(1000);
    expect(totals.total_realtime_minutes).toBe(456.7);
    expect(totals.total_estimated_cost_usd).toBeGreaterThan(0);
    expect(totals.total_realtime_responses).toBe(10);
    // text-in 0 (2M - 1M audio - 1M cached), cached 1M*$0.4, audio-in 1M*$32,
    // text-out 0.5M*$16, audio-out 0.5M*$64
    expect(totals.total_realtime_cost_usd).toBeCloseTo(0.4 + 32 + 8 + 32, 4);
  });
});

describe('estimateRealtimeCostUsd', () => {
  it('prices the text/audio/cached buckets with the gpt-realtime rates', () => {
    const cost = estimateRealtimeCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      inputAudioTokens: 500_000,
      outputAudioTokens: 500_000,
      cachedTokens: 100_000,
    });
    // text-in 0.4M*$4 + audio-in 0.5M*$32 + cached 0.1M*$0.4
    // + text-out 0.5M*$16 + audio-out 0.5M*$64
    expect(cost).toBeCloseTo(1.6 + 16 + 0.04 + 8 + 32, 6);
  });

  it('treats null counts as zero and never goes negative', () => {
    expect(estimateRealtimeCostUsd({
      inputTokens: null, outputTokens: null,
      inputAudioTokens: null, outputAudioTokens: null, cachedTokens: null,
    })).toBe(0);
    // audio + cached exceeding the input total clamps the text bucket at 0.
    const cost = estimateRealtimeCostUsd({
      inputTokens: 100, outputTokens: 0,
      inputAudioTokens: 80, outputAudioTokens: 0, cachedTokens: 50,
    });
    expect(cost).toBeGreaterThan(0);
  });
});

describe('insertRealtimeUsage', () => {
  it('passes the expected params on success', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await insertRealtimeUsage('sess-1', 'resp_1', {
      inputTokens: 100, outputTokens: 50, inputAudioTokens: 60, outputAudioTokens: 30, cachedTokens: 10,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO realtime_usage'),
      ['sess-1', 'resp_1', 100, 50, 60, 30, 10]
    );
  });

  it('never throws when the query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(insertRealtimeUsage('sess-1', null, {
      inputTokens: null, outputTokens: null, inputAudioTokens: null, outputAudioTokens: null, cachedTokens: null,
    })).resolves.toBeUndefined();
  });
});

describe('getDailySpend', () => {
  it('selects DATE(created_at) as text so date keys are strings, not JS Date objects', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await getDailySpend(30);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('DATE(created_at)::text AS date');
    // The realtime daily series must key on the same string dates.
    const realtimeSql = queryMock.mock.calls[1][0] as string;
    expect(realtimeSql).toContain('DATE(created_at)::text AS date');
    expect(realtimeSql).toContain('FROM realtime_usage');
  });

  it('merges rows for the same day and sorts descending by date string', async () => {
    // Two rows on the same day (different purpose/model) must merge into one,
    // which only works when row.date is a string the Map can key on. A regression
    // to Date-object keys would leave them unmerged and crash the final sort.
    queryMock.mockResolvedValueOnce({
      rows: [
        { date: '2026-07-30', purpose: 'insights', model: 'gpt-4o-mini', calls: '2', tokens_in: '2000', tokens_out: '600' },
        { date: '2026-07-30', purpose: 'crisis', model: 'gpt-4o-mini', calls: '1', tokens_in: '500', tokens_out: '100' },
        { date: '2026-07-29', purpose: 'redaction', model: 'gpt-5', calls: '2', tokens_in: '0', tokens_out: '0' },
      ],
    });
    // Realtime spend on one of the days, plus a realtime-only day.
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          date: '2026-07-30', input_tokens: '1000000', output_tokens: '0',
          input_audio_tokens: '1000000', output_audio_tokens: '0', cached_tokens: '0',
        },
        {
          date: '2026-07-28', input_tokens: '0', output_tokens: '1000000',
          input_audio_tokens: '0', output_audio_tokens: '1000000', cached_tokens: '0',
        },
      ],
    });

    const rows = await getDailySpend(30);

    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.date)).toEqual(['2026-07-30', '2026-07-29', '2026-07-28']);
    const day30 = rows.find(r => r.date === '2026-07-30')!;
    expect(day30.calls).toBe(3);
    expect(day30.tokens_in).toBe(2500);
    expect(day30.tokens_out).toBe(700);
    expect(day30.estimated_cost_usd).toBeGreaterThan(0);
    expect(day30.realtime_cost_usd).toBeCloseTo(32, 4); // 1M audio-in tokens
    const day28 = rows.find(r => r.date === '2026-07-28')!;
    expect(day28.calls).toBe(0);
    expect(day28.realtime_cost_usd).toBeCloseTo(64, 4); // 1M audio-out tokens
  });
});
