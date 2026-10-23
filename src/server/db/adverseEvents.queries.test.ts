import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import {
  insertAdverseEventDraft,
  updateAdverseEventDraft,
  submitAdverseEvent,
  closeAdverseEvent,
  reopenAdverseEvent,
  listAdverseEvents,
  getAdverseEventById,
  getAdverseEventCounts,
  adverseEventScopeClause,
  type AdverseEventScope,
} from './adverseEvents.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const draftInput = {
  sessionId: 'sess-1',
  crisisEventId: 7,
  userId: 42,
  sessionRef: 'sess-1',
  participantRef: 'user 42',
  occurredAt: new Date('2026-07-31T12:00:00Z'),
  severity: 'high' as const,
  triggerSource: 'auto_crisis_flag' as const,
  summary: 's',
  timeline: [],
  transcriptExcerpt: 'redacted',
  actionsTaken: [],
  dueAt: new Date('2026-08-07T12:00:00Z'),
  createdBy: 'system',
};

describe('insertAdverseEventDraft', () => {
  it('returns the new report_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ report_id: 5 }] });
    expect(await insertAdverseEventDraft(draftInput)).toBe(5);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT (crisis_event_id)');
    expect(sql).toContain('DO NOTHING');
  });

  it('returns null when ON CONFLICT DO NOTHING suppresses the insert (idempotent)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await insertAdverseEventDraft(draftInput)).toBeNull();
  });

  it("defaults category to 'crisis' and passes it as a bound param", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ report_id: 9 }] });
    await insertAdverseEventDraft(draftInput);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('category');
    expect(params).toContain('crisis');
  });

  it('auto_eligibility drafts key on the session_id partial index and carry the eligibility category', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ report_id: 10 }] });
    await insertAdverseEventDraft({
      ...draftInput,
      crisisEventId: null,
      triggerSource: 'auto_eligibility',
      category: 'eligibility_violation',
      severity: 'medium',
    });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (session_id) WHERE trigger_source = 'auto_eligibility'");
    expect(sql).toContain('DO NOTHING');
    expect(params).toContain('eligibility_violation');
    expect(params).toContain('auto_eligibility');
  });
});

describe('organization stamping on insert (migration 108)', () => {
  it('resolves organization_id from the participant when none is given', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ report_id: 11 }] });
    await insertAdverseEventDraft(draftInput);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('organization_id');
    expect(sql).toContain('COALESCE($16::int, (SELECT organization_id FROM users WHERE userid = $3))');
    expect(params).toHaveLength(16);
    expect(params[15]).toBeNull();
  });

  it('passes an explicit organizationId through as the COALESCE override', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ report_id: 12 }] });
    await insertAdverseEventDraft({ ...draftInput, organizationId: 4 });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[15]).toBe(4);
  });
});

describe('read scoping (ai-therapist-228)', () => {
  const researcher: AdverseEventScope = { orgId: 2, careTeam: null };
  const therapist: AdverseEventScope = { orgId: 2, careTeam: { role: 'therapist', memberId: 7, username: 'ther1' } };
  const caseworker: AdverseEventScope = { orgId: 2, careTeam: { role: 'caseworker', memberId: 8, username: 'cw1' } };

  it('researcher clause: own org, plus NULL-org rows only when the org is irb-study', () => {
    const { sql, params } = adverseEventScopeClause(researcher);
    expect(params).toEqual([2]);
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain(
      "organization_id IS NULL AND $1 = (SELECT org_id FROM organizations WHERE slug = 'irb-study')",
    );
    expect(sql).not.toContain('created_by');
    expect(sql).not.toContain('therapist_clients');
  });

  it('therapist clause adds caseload-or-own-filed on top of the org clause', () => {
    const { sql, params } = adverseEventScopeClause(therapist);
    expect(params).toEqual([2, 'ther1', 7]);
    expect(sql).toContain('created_by = $2');
    expect(sql).toContain('tc.therapist_id = $3 AND tc.client_id = adverse_event_reports.user_id');
    expect(sql).toContain('user_id IS NOT NULL');
  });

  it('caseworker clause adds own-filed only (no caseload widening)', () => {
    const { sql, params } = adverseEventScopeClause(caseworker);
    expect(params).toEqual([2, 'cw1']);
    expect(sql).toContain('created_by = $2');
    expect(sql).not.toContain('therapist_clients');
  });

  it('offsets parameter numbering when params are already bound', () => {
    const { sql, params } = adverseEventScopeClause(therapist, 1);
    expect(params).toEqual([2, 'ther1', 7]);
    expect(sql).toContain('organization_id = $2');
    expect(sql).toContain('created_by = $3');
    expect(sql).toContain('tc.therapist_id = $4');
  });

  it('listAdverseEvents binds status first and the scope after it', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listAdverseEvents({ status: 'draft' }, therapist);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['draft', 2, 'ther1', 7]);
    expect(sql).toContain('($1::text IS NULL OR status = $1)');
    expect(sql).toContain('organization_id = $2');
  });

  it('getAdverseEventById returns null for a row outside the scope (SQL filters it)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getAdverseEventById(5, researcher)).toBeNull();
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([5, 2]);
    expect(sql).toContain('WHERE report_id = $1 AND');
    expect(sql).toContain('organization_id = $2');
  });

  it('getAdverseEventCounts is scoped (never a global COUNT)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ draft: 1, submitted: 0, overdue: 0, due_soon: 0 }] });
    await getAdverseEventCounts(caseworker);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([2, 'cw1']);
    expect(sql).toMatch(/FROM adverse_event_reports\s+WHERE \(organization_id = \$1/);
  });
});

describe('status-transition guards', () => {
  it('submit only affects rows still in draft', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    expect(await submitAdverseEvent(5, 'nathan')).toBe(true);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'submitted'");
    expect(sql).toContain("WHERE report_id = $1 AND status = 'draft'");
  });

  it('submit returns false when the row is not a draft (no rows updated)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    expect(await submitAdverseEvent(5, 'nathan')).toBe(false);
  });

  it('close only affects submitted rows', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    expect(await closeAdverseEvent(5, 'nathan')).toBe(true);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'closed'");
    expect(sql).toContain("WHERE report_id = $1 AND status = 'submitted'");
  });

  it('reopen returns submitted rows to draft and clears the sign-off', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    expect(await reopenAdverseEvent(5)).toBe(true);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain('submitted_by = NULL');
    expect(sql).toContain("WHERE report_id = $1 AND status = 'submitted'");
  });
});

describe('updateAdverseEventDraft', () => {
  it('edits are blocked outside draft (WHERE status = draft) and build dynamic SET', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await updateAdverseEventDraft(5, { summary: 'new', severity: 'medium' });
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("WHERE report_id = $3 AND status = 'draft'");
    expect(params).toEqual(['new', 'medium', 5]);
  });

  it('returns false without querying when no editable fields are supplied', async () => {
    const ok = await updateAdverseEventDraft(5, {});
    expect(ok).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('serializes JSONB fields (actions_taken/timeline)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await updateAdverseEventDraft(5, { actions_taken: [{ at: null, action: 'x', by: 'me' }] });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('actions_taken = $1::jsonb');
    expect(params[0]).toBe(JSON.stringify([{ at: null, action: 'x', by: 'me' }]));
  });
});
