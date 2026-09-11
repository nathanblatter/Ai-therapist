import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock } }));

import {
  estimateLiveCostUsd,
  recordLiveUsage,
  getLiveUsage,
  getLiveUsageTotals,
  LIVE_RATES_PER_MINUTE,
} from './liveUsage.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('estimateLiveCostUsd', () => {
  it('bills 0.05 per minute for gpt-live-1', () => {
    expect(LIVE_RATES_PER_MINUTE['gpt-live-1']).toBe(0.05);
    expect(estimateLiveCostUsd('gpt-live-1', 60)).toBe(0.05);
    expect(estimateLiveCostUsd('gpt-live-1', 600)).toBe(0.5);
  });

  it('does NOT round partial minutes up — 90 seconds is 0.075, not 0.10', () => {
    expect(estimateLiveCostUsd('gpt-live-1', 90)).toBe(0.075);
    expect(estimateLiveCostUsd('gpt-live-1', 90)).not.toBe(0.1);
    expect(estimateLiveCostUsd('gpt-live-1', 30)).toBe(0.025);
    expect(estimateLiveCostUsd('gpt-live-1', 1)).toBeCloseTo(0.000833, 6);
  });

  it('falls back to the default rate for an unknown or null model', () => {
    expect(estimateLiveCostUsd('gpt-live-9-unreleased', 120)).toBe(0.1);
    expect(estimateLiveCostUsd(null, 120)).toBe(0.1);
  });

  it('is zero for a missing, zero or negative duration', () => {
    expect(estimateLiveCostUsd('gpt-live-1', null)).toBe(0);
    expect(estimateLiveCostUsd('gpt-live-1', 0)).toBe(0);
    expect(estimateLiveCostUsd('gpt-live-1', -30)).toBe(0);
  });

  it('rounds to six decimal places (no float dust)', () => {
    const cost = estimateLiveCostUsd('gpt-live-1', 7);
    expect(cost).toBe(Math.round(cost * 1_000_000) / 1_000_000);
  });
});

describe('recordLiveUsage', () => {
  it('upserts one row per session with the snapshot and flags', async () => {
    await recordLiveUsage('s-1', 'gpt-live-1', 118, {
      finalized: true, closeReason: 'client_closed', contextRatio: 0.42,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (session_id) DO UPDATE');
    // The latest snapshot wins, but never moves the total backwards.
    expect(sql).toContain('GREATEST(live_usage.duration_seconds, EXCLUDED.duration_seconds)');
    // finalized is sticky.
    expect(sql).toContain('live_usage.finalized OR EXCLUDED.finalized');
    expect(params).toEqual(['s-1', 'gpt-live-1', 118, true, 'client_closed', 0.42]);
  });

  it('defaults finalized to false and the optional fields to null', async () => {
    await recordLiveUsage('s-2', 'gpt-live-1', 12);
    expect(queryMock.mock.calls[0][1]).toEqual(['s-2', 'gpt-live-1', 12, false, null, null]);
  });

  it('swallows DB errors so metering can never affect a live voice session', async () => {
    queryMock.mockRejectedValue(new Error('connection terminated'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordLiveUsage('s-3', 'gpt-live-1', 5)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('getLiveUsage', () => {
  it('returns the row for a session, or null when it never ran on GPT-Live', async () => {
    queryMock.mockResolvedValue({ rows: [{ session_id: 's-1', duration_seconds: 90 }] });
    expect(await getLiveUsage('s-1')).toMatchObject({ session_id: 's-1', duration_seconds: 90 });

    queryMock.mockResolvedValue({ rows: [] });
    expect(await getLiveUsage('s-none')).toBeNull();
  });
});

describe('getLiveUsageTotals', () => {
  it('reports unfinalized sessions alongside the cost estimate', async () => {
    queryMock.mockResolvedValue({
      rows: [{ sessions: '4', unfinalized_sessions: '1', total_seconds: 90, model: 'gpt-live-1' }],
    });

    expect(await getLiveUsageTotals(7)).toEqual({
      sessions: 4,
      unfinalized_sessions: 1,
      total_seconds: 90,
      estimated_cost_usd: 0.075,
    });
  });

  it('is safe on an empty window', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await getLiveUsageTotals(30)).toEqual({
      sessions: 0, unfinalized_sessions: 0, total_seconds: 0, estimated_cost_usd: 0,
    });
  });
});
