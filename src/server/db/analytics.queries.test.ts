// Analytics dashboard query (ai-therapist-236 chunk 4): one CTE query drives
// every metric, so a dropped demo exclusion or a swapped filter slot skews
// the whole dashboard at once.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import { getDashboardAnalytics, type AnalyticsFilters } from './analytics.queries.js';

const FILTERS: AnalyticsFilters = {
  startDate: '2026-01-01',
  endDate: '2026-02-01',
  voices: ['alloy'],
  languages: ['en'],
  sessionTypes: ['voice'],
  statuses: ['ended'],
  endedBy: ['user'],
  crisisFlagged: false,
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('getDashboardAnalytics', () => {
  it('excludes demo sessions and binds the filters in order', async () => {
    const row = { metrics: { total_sessions: 3 }, breakdown: {} };
    queryMock.mockResolvedValue({ rows: [row] });
    await expect(getDashboardAnalytics(FILTERS)).resolves.toBe(row);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['2026-01-01', '2026-02-01', ['alloy'], ['en'], ['voice'], ['ended'], ['user'], false]);
    expect(sql).toMatch(
      /FROM therapy_sessions ts\s+LEFT JOIN session_configurations sc ON ts\.session_id = sc\.session_id\s+WHERE\s+ts\.is_demo IS NOT TRUE/,
    );
    expect(sql).toContain('($1::TIMESTAMP IS NULL OR ts.created_at >= $1)');
    expect(sql).toContain('($2::TIMESTAMP IS NULL OR ts.created_at <= $2)');
    expect(sql).toContain('($3::TEXT[] IS NULL OR sc.voice = ANY($3))');
    expect(sql).toContain('($4::TEXT[] IS NULL OR sc.language = ANY($4))');
    expect(sql).toContain('($5::TEXT[] IS NULL OR ts.session_type = ANY($5))');
    expect(sql).toContain('($6::TEXT[] IS NULL OR ts.status = ANY($6))');
    expect(sql).toContain('($7::TEXT[] IS NULL OR ts.ended_by = ANY($7))');
    expect(sql).toContain('($8::BOOLEAN IS NULL OR ts.crisis_flagged = $8)');
    // No other parameter slots exist: a $9 would be an unbound placeholder.
    expect(sql).not.toMatch(/\$9\b/);
  });

  it('derives every message metric from sessions that passed the filter, never from raw messages', async () => {
    queryMock.mockResolvedValue({ rows: [{}] });
    await getDashboardAnalytics(FILTERS);
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toMatch(
      /date_filtered_messages AS \(\s+SELECT m\.\* FROM messages m\s+INNER JOIN date_filtered_sessions ts ON m\.session_id = ts\.session_id\s+\)/,
    );
    // Every later CTE reads from the filtered views, not the base tables. The
    // one deliberate exception is the sideband reliability KPI: a fixed 7-day
    // window independent of the dashboard filters, with its own demo exclusion.
    const afterCtes = sql.slice(sql.indexOf('session_metrics AS'));
    expect(afterCtes).not.toMatch(/FROM messages\b/);
    const baseSessionReads = afterCtes.match(/FROM therapy_sessions\b/g) ?? [];
    expect(baseSessionReads).toHaveLength(1);
    expect(afterCtes).toMatch(
      /sideband_reliability AS \([\s\S]*?FROM therapy_sessions\s+WHERE is_demo IS NOT TRUE\s+AND session_type = 'realtime'\s+AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'/,
    );
  });

  it('passes nulls through so a blank filter matches everything', async () => {
    queryMock.mockResolvedValue({ rows: [{}] });
    await getDashboardAnalytics({
      startDate: null,
      endDate: null,
      voices: null,
      languages: null,
      sessionTypes: null,
      statuses: null,
      endedBy: null,
      crisisFlagged: null,
    });
    expect(queryMock.mock.calls[0][1]).toEqual([null, null, null, null, null, null, null, null]);
  });
});
