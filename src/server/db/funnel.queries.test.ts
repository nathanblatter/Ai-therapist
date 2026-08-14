// Coverage for the product-funnel query (pass-3 telemetry): result shape,
// null-row safety, and the parameterized window.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getFunnel } from './funnel.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('getFunnel', () => {
  it('returns all six stages from the aggregate row', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        created: 100,
        with_checkin: 80,
        connected: 75,
        with_user_turn: 60,
        with_tool_use: 25,
        ended_gracefully: 50,
      }],
    });

    const funnel = await getFunnel(30);
    expect(funnel).toEqual({
      created: 100,
      with_checkin: 80,
      connected: 75,
      with_user_turn: 60,
      with_tool_use: 25,
      ended_gracefully: 50,
    });
  });

  it('binds the day window as a parameter', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{}] });
    await getFunnel(7);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([7]);
    expect(sql).toContain('make_interval(days => $1)');
    // Demo sessions must never pollute the research funnel.
    expect(sql).toContain('is_demo IS NOT TRUE');
  });

  it('zero-fills when the query returns no rows', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const funnel = await getFunnel(30);
    expect(funnel).toEqual({
      created: 0,
      with_checkin: 0,
      connected: 0,
      with_user_turn: 0,
      with_tool_use: 0,
      ended_gracefully: 0,
    });
  });

  it('mirrors the analytics abandonment definition for graceful ends', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{}] });
    await getFunnel(30);
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toContain('ended_by IS NOT NULL');
    expect(sql).toContain(">= 60");
  });
});
