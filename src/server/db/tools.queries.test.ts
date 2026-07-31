import { describe, it, expect, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  getToolInvocationStats,
  getToolsPerSessionDistribution,
  getToolUsageSessionCounts,
} from './tools.queries.js';

describe('getToolInvocationStats', () => {
  it('computes failure_rate as a rounded percentage of failures over invocations', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { tool_name: 'log_mood', invocations: '10', sessions: '8', last_used: new Date('2026-01-01'), failures: '1' },
        { tool_name: 'end_session', invocations: '4', sessions: '4', last_used: null, failures: '0' },
      ],
    });

    const stats = await getToolInvocationStats();

    expect(stats).toEqual([
      { tool_name: 'log_mood', invocations: 10, sessions: 8, last_used: new Date('2026-01-01'), failures: 1, failure_rate: 10 },
      { tool_name: 'end_session', invocations: 4, sessions: 4, last_used: null, failures: 0, failure_rate: 0 },
    ]);
  });

  it('returns an empty list with no rows', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getToolInvocationStats()).toEqual([]);
  });
});

describe('getToolsPerSessionDistribution', () => {
  it('parses distinct_tool_count and session_count as numbers', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { distinct_tool_count: '1', session_count: '20' },
        { distinct_tool_count: '3', session_count: '5' },
      ],
    });

    expect(await getToolsPerSessionDistribution()).toEqual([
      { distinct_tool_count: 1, session_count: 20 },
      { distinct_tool_count: 3, session_count: 5 },
    ]);
  });
});

describe('getToolUsageSessionCounts', () => {
  it('parses the single-row totals', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ total_sessions: '100', sessions_with_tool_use: '42' }],
    });

    expect(await getToolUsageSessionCounts()).toEqual({
      total_sessions: 100,
      sessions_with_tool_use: 42,
    });
  });

  it('defaults to zero when no row is returned', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getToolUsageSessionCounts()).toEqual({
      total_sessions: 0,
      sessions_with_tool_use: 0,
    });
  });
});
