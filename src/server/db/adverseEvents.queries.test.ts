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
} from './adverseEvents.queries.js';

beforeEach(() => {
  queryMock.mockReset();
});

const draftInput = {
  sessionId: 'sess-1', crisisEventId: 7, userId: 42, sessionRef: 'sess-1', participantRef: 'user 42',
  occurredAt: new Date('2026-07-31T12:00:00Z'), severity: 'high' as const, triggerSource: 'auto_crisis_flag' as const,
  summary: 's', timeline: [], transcriptExcerpt: 'redacted', actionsTaken: [], dueAt: new Date('2026-08-07T12:00:00Z'), createdBy: 'system',
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
