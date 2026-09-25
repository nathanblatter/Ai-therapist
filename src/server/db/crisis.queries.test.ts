// SQL-shape coverage for the crisis dashboard queries (red-team round 3,
// finding 5): the researcher org clause must resolve the owning user via
// COALESCE(ts.user_id, ce.client_user_id) so thread-origin crisis events
// (076: session_id NULL) are org-restricted instead of passing as anonymous.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, on: vi.fn() },
}));

import { getAllCrisisData, getAllCrisisEvents, getRecentSessionMessages } from './crisis.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

const CRISIS_ORG_CLAUSE =
  'COALESCE(ts.user_id, ce.client_user_id) IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = COALESCE(ts.user_id, ce.client_user_id)';

describe('getAllCrisisEvents org scoping', () => {
  it('is unscoped without a therapist scope or org', async () => {
    await getAllCrisisEvents();
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).not.toContain('organization_id');
    expect(sql).not.toContain('therapist_clients');
    expect(queryMock.mock.calls[0][1]).toEqual([]);
  });

  it('org-scopes thread-origin events via ce.client_user_id (076)', async () => {
    await getAllCrisisEvents(null, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain(CRISIS_ORG_CLAUSE);
    expect(queryMock.mock.calls[0][1]).toEqual([3]);
  });

  it('stacks the caseload scope with the org scope', async () => {
    await getAllCrisisEvents(7, 3);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('therapist_clients');
    expect(sql).toContain(CRISIS_ORG_CLAUSE);
    expect(queryMock.mock.calls[0][1]).toEqual([7, 3]);
  });
});

describe('getAllCrisisData org scoping', () => {
  it('applies the client_user_id-aware clause to crisis_events only; session tables keep ts.user_id', async () => {
    await getAllCrisisData(null, 3);
    expect(queryMock).toHaveBeenCalledTimes(3);
    const [crisisSql, iaSql, rshSql] = queryMock.mock.calls.map((c) => String(c[0]));
    expect(crisisSql).toContain('FROM crisis_events ce');
    expect(crisisSql).toContain(CRISIS_ORG_CLAUSE);
    for (const sql of [iaSql, rshSql]) {
      expect(sql).toContain('ts.user_id IS NULL OR EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id');
      expect(sql).not.toContain('client_user_id');
    }
    for (const call of queryMock.mock.calls) {
      expect(call[1]).toEqual([3]);
    }
  });

  it('passes no org clause when orgId is null (care-team scoped path)', async () => {
    await getAllCrisisData(7, null);
    for (const call of queryMock.mock.calls) {
      expect(String(call[0])).not.toContain('organization_id');
      expect(call[1]).toEqual([7]);
    }
  });
});

// ai-therapist-223: the crisis context window took the last 10 message rows of
// any kind. Each tool invocation writes two system rows (tool_call +
// tool_response), so a turn using a worksheet, a scale and a journaling prompt
// evicted the participant's own words from the window the LLM assessor reads.
describe('getRecentSessionMessages crisis window', () => {
  it('restricts the window to conversational turns so tool bookkeeping cannot evict them', async () => {
    await getRecentSessionMessages('sess-1', 10);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("role IN ('user', 'assistant')");
    expect(String(sql)).toContain('message_type <> ALL($3::text[])');
    expect(params[0]).toBe('sess-1');
    expect(params[1]).toBe(10);
    const excluded = params[2] as string[];
    for (const type of ['tool_call', 'tool_response', 'function_call', 'notable_moment']) {
      expect(excluded).toContain(type);
    }
  });

  it('never excludes participant- or assistant-authored rows', async () => {
    await getRecentSessionMessages('sess-1');
    const excluded = (queryMock.mock.calls[0] as [string, unknown[]])[1][2] as string[];
    for (const type of ['text', 'voice', 'response', 'chat', 'thought_record', 'values_sort', 'fear_ladder']) {
      expect(excluded).not.toContain(type);
    }
  });

  it('returns the filtered rows oldest-first', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { role: 'user', content: 'newest', content_redacted: null },
        { role: 'assistant', content: 'older', content_redacted: null },
      ],
    });
    const rows = await getRecentSessionMessages('sess-1', 2);
    expect(rows.map((r) => r.content)).toEqual(['older', 'newest']);
  });
});
