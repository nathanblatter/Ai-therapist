// SQL-shape coverage for the rating queue (eval program WP2): the list and
// count queries must carry the same caseload / org scoping as the crisis
// dashboards, demo sessions never appear, and the claim / link transitions
// are expressed in one conditional UPDATE each.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, on: vi.fn() } }));

import {
  getRatingCandidates,
  insertRatingQueueRows,
  listRatingQueue,
  getRatingQueueCounts,
  claimRatingQueueRow,
  skipRatingQueueRow,
  linkRatingToQueue,
  hasHumanRating,
} from './ratingQueue.queries.js';
import { countUnadjudicatedCrisisEvents, upsertCrisisEventAdjudication } from './crisisAdjudications.queries.js';

const ORG_CLAUSE =
  "(EXISTS (SELECT 1 FROM users ou WHERE ou.userid = ts.user_id AND ou.organization_id = $2) OR (ts.user_id IS NULL AND $2 = (SELECT org_id FROM organizations WHERE slug = 'irb-study')))";

beforeEach(() => queryMock.mockReset().mockResolvedValue({ rows: [] }));

describe('getRatingCandidates', () => {
  it('selects ended, non-demo, non-sandbox, unqueued sessions with a participant turn', async () => {
    await getRatingCandidates(new Date('2026-09-01T00:00:00Z'), 10);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ts.status = 'ended'");
    expect(sql).toContain('ts.is_demo IS NOT TRUE');
    expect(sql).toContain('u.is_sandbox IS NOT TRUE');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM eval_rating_queue q');
    expect(sql).toContain("m.role = 'user'");
    expect(sql).toContain('risk_score_history');
    expect(sql).toContain('crisis_events');
    expect(params).toEqual([new Date('2026-09-01T00:00:00Z'), 10]);
  });
});

describe('insertRatingQueueRows', () => {
  it('skips the query for an empty batch and uses ON CONFLICT DO NOTHING otherwise', async () => {
    expect(await insertRatingQueueRows([], 1)).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
    await insertRatingQueueRows([{ session_id: 's', stratum: 'chat|none|2026-W42', source: 'manual', needs_second_rater: false, crisis_adjacent: false }], 1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (session_id) DO NOTHING');
    expect(JSON.parse(params[0])[0].session_id).toBe('s');
    expect(params[1]).toBe(1);
  });
});

describe('listRatingQueue scoping', () => {
  it('is unscoped for an unscoped caller but still excludes demo sessions', async () => {
    await listRatingQueue({ userId: 1 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ts.is_demo IS NOT TRUE');
    expect(sql).not.toContain('organization_id');
    expect(sql).not.toContain('therapist_clients');
    expect(params).toEqual([1, 200]);
  });

  it('org-scopes a researcher with the shared owner-org rule (anonymous -> irb-study)', async () => {
    await listRatingQueue({ userId: 1, orgId: 3 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(ORG_CLAUSE);
    expect(params).toEqual([1, 3, 200]);
  });

  it('caseload-scopes a therapist and adds the mine / status filters', async () => {
    await listRatingQueue({ userId: 7, scopeTherapistId: 7, mine: true, status: 'open', limit: 50 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('therapist_clients tc WHERE tc.therapist_id = $2 AND tc.client_id = ts.user_id');
    expect(sql).toContain('(q.assigned_to = $1 OR q.second_rater_id = $1)');
    expect(sql).toContain("q.status IN ('queued', 'in_progress')");
    expect(params).toEqual([7, 7, 50]);
  });

  it('binds an explicit status', async () => {
    await listRatingQueue({ userId: 1, status: 'rated' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('q.status = $2');
    expect(params).toEqual([1, 'rated', 200]);
  });
});

describe('getRatingQueueCounts', () => {
  it('applies the org scope and returns the aggregate row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ queued: 2, in_progress: 1, rated: 0, skipped: 0, awaiting_second_rater: 1, double_rated: 0 }] });
    const counts = await getRatingQueueCounts({ orgId: 3 });
    expect(counts.queued).toBe(2);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(ORG_CLAUSE.replaceAll('$2', '$1'));
    expect(params).toEqual([3]);
  });
});

describe('claim / skip / link transitions', () => {
  it('claim takes a free slot or the second-rater slot and returns null when not claimable', async () => {
    expect(await claimRatingQueueRow(5, 9)).toBeNull();
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status IN ('queued', 'in_progress')");
    expect(sql).toContain('needs_second_rater AND second_rater_id IS NULL AND assigned_to <> $2');
    expect(sql).toContain("CASE WHEN status = 'queued' THEN 'in_progress'");
    expect(params).toEqual([5, 9]);
  });

  it('skip only touches open rows', async () => {
    await skipRatingQueueRow(5, 9);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status = 'skipped'");
    expect(sql).toContain("status IN ('queued', 'in_progress')");
    expect(params).toEqual([5, 9]);
  });

  it('link marks the row rated once the required rater count is met, never a skipped row', async () => {
    await linkRatingToQueue('sess', 9);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('COUNT(DISTINCT rater_user_id)');
    expect(sql).toContain('CASE WHEN q.needs_second_rater THEN 2 ELSE 1 END');
    expect(sql).toContain("q.status <> 'skipped'");
    expect(params).toEqual(['sess', 9]);
  });

  it('hasHumanRating is a (session, rater) existence check', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await hasHumanRating('sess', 9)).toBe(true);
    expect(queryMock.mock.calls[0][1]).toEqual(['sess', 9]);
  });
});

describe('crisis adjudications', () => {
  it('counts unadjudicated events under the crisis-dashboard owner rule', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ n: 4 }] });
    expect(await countUnadjudicatedCrisisEvents(7, 3)).toBe(4);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM crisis_event_adjudications a WHERE a.crisis_event_id = ce.event_id)');
    expect(sql).toContain('tc.client_id = COALESCE(ts.user_id, ce.client_user_id)');
    expect(sql).toContain('ou.userid = COALESCE(ts.user_id, ce.client_user_id) AND ou.organization_id = $2');
    expect(sql).toContain('ts.is_demo IS NOT TRUE');
    expect(params).toEqual([7, 3]);
  });

  it('upserts one verdict per (event, adjudicator)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ adjudication_id: 1 }] });
    await upsertCrisisEventAdjudication(12, 9, 'false_positive', null);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (crisis_event_id, adjudicator_id) DO UPDATE');
    expect(params).toEqual([12, 9, 'false_positive', null]);
  });
});
