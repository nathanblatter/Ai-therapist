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

import { updateRedactedContent, recordRedactionApproval } from './redaction.queries.js';

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
      .mockResolvedValueOnce({}); // COMMIT

    await expect(updateRedactedContent('42', '[REDACTED]', 7)).resolves.toBe(true);

    const sqls = clientQueryMock.mock.calls.map((c) => String(c[0]).trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/UPDATE messages SET content_redacted/);
    expect(sqls[2]).toMatch(/INSERT INTO redaction_review_log/);
    expect(sqls[2]).toMatch(/'corrected'/);
    expect(clientQueryMock.mock.calls[2][1]).toEqual(['42', 7]);
    expect(sqls[3]).toBe('COMMIT');
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
