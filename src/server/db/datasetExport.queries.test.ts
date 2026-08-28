// SQL-shape coverage for the research dataset export queries (red-team round
// 3, finding 6): thread-origin crisis events (076: session_id NULL) must be
// included in crisis_events.csv and the per-participant rollup via
// client_user_id, never silently dropped by the session INNER JOIN.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, on: vi.fn() },
}));

import { getCrisisEventsExport, getParticipantsExport } from './datasetExport.queries.js';

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('getCrisisEventsExport', () => {
  it('includes thread-origin events via client_user_id with a thread_origin marker', async () => {
    await getCrisisEventsExport('2026-08-27T00:00:00Z');
    const sql = String(queryMock.mock.calls[0][0]);
    // Session join is no longer an INNER JOIN that drops session-less rows.
    expect(sql).toContain('LEFT JOIN sess ON sess.session_id = ce.session_id');
    expect(sql).toContain('(ce.session_id IS NULL) AS thread_origin');
    // Thread-origin arm: real (non-sandbox) clients only, asOf-bounded by
    // event time since there is no session to bound by.
    expect(sql).toContain('ce.session_id IS NULL AND ce.client_user_id IS NOT NULL');
    expect(sql).toContain('cu.is_sandbox IS NOT TRUE AND ce.created_at <= $1');
    // Session-origin rows keep the original in-scope-session requirement.
    expect(sql).toContain('ce.session_id IS NOT NULL AND sess.session_id IS NOT NULL');
    // Participant pseudonym resolves through the session owner or the
    // thread-origin client.
    expect(sql).toContain("pp.entity_key = COALESCE(sess.user_id, ce.client_user_id)::text");
    // Determinism: total order even with empty session pseudonyms.
    expect(sql).toContain("ORDER BY COALESCE(sess.session_pseudo_id, ''), ce.created_at, ce.event_id");
    expect(queryMock.mock.calls[0][1]).toEqual(['2026-08-27T00:00:00Z']);
  });
});

describe('getParticipantsExport', () => {
  it('counts thread-origin crisis events in n_crisis_events via client_user_id', async () => {
    await getParticipantsExport('2026-08-27T00:00:00Z');
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('SELECT ce.client_user_id AS user_id');
    expect(sql).toContain('WHERE ce.session_id IS NULL AND ce.client_user_id IS NOT NULL');
    expect(sql).toContain('UNION ALL');
    // asOf bound on the thread-origin arm (session arm is bounded via sess).
    expect(sql).toMatch(/client_user_id IS NOT NULL\s+AND ce\.created_at <= \$1/);
  });
});
