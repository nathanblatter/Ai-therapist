// Redaction-review accountability (091): a manual correction and its
// redaction_review_log row are written in ONE transaction, and no-change
// approvals are recorded only for messages that exist.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, connectMock, clientQueryMock, releaseMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  return {
    queryMock: vi.fn(),
    clientQueryMock,
    releaseMock,
    connectMock: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  };
});
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import { updateRedactedContent, recordRedactionApproval, listRedactionReviewLog } from './redaction.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

describe('updateRedactedContent', () => {
  it('updates the content and inserts a corrected review row in one transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_id: 42 }] }) // UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT review
      .mockResolvedValueOnce({ rowCount: 1 }) // mark leak-check reviewed (262)
      .mockResolvedValueOnce({}); // COMMIT

    await expect(updateRedactedContent('42', '[REDACTED]', 7)).resolves.toBe(true);

    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]).trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/UPDATE messages SET content_redacted/);
    expect(sqls[2]).toMatch(/INSERT INTO redaction_review_log/);
    expect(sqls[2]).toMatch(/'corrected'/);
    expect(clientQueryMock.mock.calls[2][1]).toEqual(['42', 7]);
    expect(sqls[3]).toMatch(/jsonb_set\(metadata, '\{redaction_check,reviewed\}'/);
    expect(sqls[4]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rolls back and returns false when the message does not exist', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE misses
      .mockResolvedValueOnce({}); // ROLLBACK

    await expect(updateRedactedContent('999', 'x', 7)).resolves.toBe(false);
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]).trim());
    expect(sqls[2]).toBe('ROLLBACK');
    expect(sqls.join(' ')).not.toMatch(/redaction_review_log/);
  });

  it('rolls back the content update when the review insert fails (no unlogged correction)', async () => {
    clientQueryMock
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_id: 42 }] }) // UPDATE
      .mockRejectedValueOnce(new Error('insert failed')) // INSERT review
      .mockResolvedValueOnce({}); // ROLLBACK

    await expect(updateRedactedContent('42', 'x', 7)).rejects.toThrow('insert failed');
    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]).trim());
    expect(sqls[3]).toBe('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe('recordRedactionApproval', () => {
  it('records an approved row for an existing message', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [{ review_id: 1 }] });
    await expect(recordRedactionApproval('42', 7)).resolves.toBe(true);
    expect(queryMock.mock.calls[0][0]).toMatch(/INSERT INTO redaction_review_log/);
    expect(queryMock.mock.calls[0][1]).toEqual(['42', 7]);
  });

  it('returns false when the message does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(recordRedactionApproval('999', 7)).resolves.toBe(false);
  });
});

describe('leak-check review queue (ai-therapist-262)', () => {
  it('lists flagged-unreviewed rows first and exposes the verdict', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { getRandomRedactedMessages } = await import('./redaction.queries.js');
    await getRandomRedactedMessages(2);
    const [sql, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("metadata->'redaction_check' AS redaction_check");
    expect(sql).toMatch(/ORDER BY \(\(metadata->'redaction_check'->>'flagged'\) = 'true'/);
    expect(sql).toContain('RANDOM()');
    expect(params).toEqual([2]);
  });

  it('counts only flagged rows nobody has reviewed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ n: '3' }] });
    const { countFlaggedUnreviewed } = await import('./redaction.queries.js');
    expect(await countFlaggedUnreviewed(2)).toBe(3);
    const [sql, params] = queryMock.mock.calls.at(-1) as [string, unknown[]];
    expect(sql).toContain("->>'reviewed', 'false') <> 'true'");
    expect(params).toEqual([2]);
  });

  it('scopes the queue and the count to the caller org, anonymous sessions irb-study only (ai-therapist-272)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: '0' }] });
    const { getRandomRedactedMessages, countFlaggedUnreviewed } = await import('./redaction.queries.js');
    await getRandomRedactedMessages(2);
    await countFlaggedUnreviewed(2);
    for (const call of queryMock.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toMatch(
        /EXISTS \(\s*SELECT 1 FROM therapy_sessions ts\s+LEFT JOIN users u ON u.userid = ts.user_id\s+WHERE ts.session_id = messages.session_id/,
      );
      expect(sql).toContain('u.organization_id = $1');
      expect(sql).toMatch(/ts.user_id IS NULL AND \$1 = \(SELECT org_id FROM organizations WHERE slug = 'irb-study'\)/);
    }
  });

  it('marks the leak-check reviewed on approval', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ review_id: 1 }], rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
    const { recordRedactionApproval } = await import('./redaction.queries.js');
    expect(await recordRedactionApproval('42', 9)).toBe(true);
    const sqls = queryMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.at(-1)).toMatch(/jsonb_set\(metadata, '\{redaction_check,reviewed\}', 'true'::jsonb\)/);
  });
});

describe('listRedactionReviewLog', () => {
  it('pages the review log newest first with reviewer and session context joined', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ review_id: 9, action: 'corrected' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] });
    const page = await listRedactionReviewLog({ reviewedBy: 5, action: 'corrected', limit: 10, offset: 20 });
    expect(page).toEqual({ rows: [{ review_id: 9, action: 'corrected' }], total: 4 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/FROM redaction_review_log rrl/);
    expect(sql).toMatch(/LEFT JOIN users u/);
    expect(sql).toMatch(/LEFT JOIN messages m/);
    expect(sql).toMatch(/ORDER BY rrl.review_id DESC/);
    expect(params).toEqual([5, 'corrected', null, 10, 20]);
    expect(queryMock.mock.calls[1][1]).toEqual([5, 'corrected', null]);
  });

  it('org-scopes page and count by the participant org, ownerless rows irb-study only (ai-therapist-272)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await listRedactionReviewLog({ limit: 10, offset: 0 }, 2);
    for (const call of queryMock.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toMatch(/LEFT JOIN therapy_sessions ts ON ts.session_id = m.session_id/);
      expect(sql).toMatch(/LEFT JOIN users pu ON pu.userid = ts.user_id/);
      expect(sql).toMatch(/\$3::int IS NULL OR pu.organization_id = \$3/);
      expect(sql).toMatch(/ts.user_id IS NULL AND \$3 = \(SELECT org_id FROM organizations WHERE slug = 'irb-study'\)/);
    }
    expect(queryMock.mock.calls[0][1]).toEqual([null, null, 2, 10, 0]);
    expect(queryMock.mock.calls[1][1]).toEqual([null, null, 2]);
  });
});
