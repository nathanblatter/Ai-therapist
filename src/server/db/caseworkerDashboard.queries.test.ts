import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  listCaseworkerRoster,
  getRosterClientDetail,
  getClientEngagementSignals,
} from './caseworkerDashboard.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('summaries-tier audit boundary', () => {
  it('the roster query NEVER touches the messages table or verbatim columns', async () => {
    await listCaseworkerRoster(7);
    const sql = String(queryMock.mock.calls[0][0]);
    // Load-bearing: this module is the caseworker tier's audit boundary.
    expect(sql).not.toMatch(/\bmessages\b/);
    expect(sql).not.toContain('soap_note');
    expect(sql).not.toContain('score_factors');
    expect(sql).not.toContain('content');
  });

  it('the detail queries never touch the messages table or verbatim columns', async () => {
    await getRosterClientDetail(42);
    for (const call of queryMock.mock.calls) {
      const sql = String(call[0]);
      expect(sql).not.toMatch(/\bmessages\b/);
      expect(sql).not.toContain('soap_note');
      expect(sql).not.toContain('score_factors');
    }
  });

  it('the engagement-signals query never touches the messages table or verbatim columns', async () => {
    await getClientEngagementSignals(42);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).not.toMatch(/\bmessages\b/);
    expect(sql).not.toContain('soap_note');
    expect(sql).not.toContain('score_factors');
    expect(sql).not.toContain('content');
  });
});

describe('listCaseworkerRoster', () => {
  it('is one round trip scoped to the member caseload', async () => {
    await listCaseworkerRoster(7);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('tc.therapist_id = $1');
    expect(queryMock.mock.calls[0][1]).toEqual([7]);
  });
});

describe('getClientEngagementSignals', () => {
  it('falls back to zeroed signals when the query returns no row', async () => {
    const signals = await getClientEngagementSignals(42);
    expect(signals).toEqual({
      last_session_at: null,
      ended_session_count: 0,
      last_checkin_mood: null,
      open_crisis_count: 0,
      open_escalation_count: 0,
      has_safety_plan: false,
    });
    expect(queryMock.mock.calls[0][1]).toEqual([42]);
  });
});

describe('getRosterClientDetail', () => {
  it('returns the summary-tier bundle shape with a null safety plan fallback', async () => {
    const detail = await getRosterClientDetail(42);
    expect(detail).toEqual({
      recent_summaries: [],
      scale_history: [],
      risk_history: [],
      mood_history: [],
      safety_plan: null,
    });
  });
});
