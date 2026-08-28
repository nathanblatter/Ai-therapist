// Message retention SQL (caseworker portal spec section 10 item 8): thread
// messages age out / wipe / export on the same records policy as session data.
// SQL-shape unit tests over a mocked pool, matching messaging.queries.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));
  return { queryMock: vi.fn(), clientQueryMock, releaseMock, connectMock };
});
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: connectMock, on: vi.fn() },
}));

import {
  deleteAgedThreadMessages,
  wipeAgedThreadMessageBodies,
  getMessageHistoryForClient,
} from './messagingRetention.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
});

const DELETE_INPUT = {
  days: 90,
  runId: 'run-1',
  policySnapshot: { recordings_retention_days: 90 },
  triggeredBy: 'scheduler' as const,
  triggeredByUser: null,
};

describe('deleteAgedThreadMessages', () => {
  it('deletes in FK order (null crisis ref, delete crisis_events, delete messages) with the audit row in the same transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ message_id: '11' }, { message_id: '12' }] }) // aged select
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // null crisis_event_id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // delete crisis_events
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // delete thread_messages
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit insert
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await deleteAgedThreadMessages(DELETE_INPUT);

    expect(result).toEqual({ messagesDeleted: 2, crisisEventsDeleted: 1 });
    const sqls = clientQueryMock.mock.calls.map(c => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    // Aged selection is retention-windowed and joins for sandbox exclusion.
    expect(sqls[1]).toContain(`now() - ($1 || ' days')::interval`);
    expect(sqls[1]).toContain('mt.is_sandbox IS NOT TRUE');
    expect(sqls[1]).toContain('cu.is_sandbox IS NOT TRUE');
    expect(clientQueryMock.mock.calls[1][1]).toEqual([90]);
    // FK order: release the message->event reference, then delete the
    // crisis_events referencing the aged messages, THEN the messages.
    expect(sqls[2]).toContain('SET crisis_event_id = NULL');
    expect(sqls[3]).toContain('DELETE FROM crisis_events WHERE thread_message_id = ANY');
    expect(sqls[4]).toContain('DELETE FROM thread_messages WHERE message_id = ANY');
    // Audit row shares the transaction (before COMMIT), with the new
    // artifact_type/reason values.
    expect(sqls[5]).toContain('INSERT INTO data_deletion_log');
    expect(sqls[5]).toContain(`'thread_message'`);
    expect(sqls[5]).toContain(`'message_retention'`);
    expect(clientQueryMock.mock.calls[5][1]).toEqual([
      'run-1',
      'thread_messages:2 crisis_events:1',
      JSON.stringify({ recordings_retention_days: 90 }),
      'scheduler',
      null,
    ]);
    expect(sqls[6]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('is a no-op (no deletes, no audit row) when nothing is aged out', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // aged select: empty
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await deleteAgedThreadMessages(DELETE_INPUT);

    expect(result).toEqual({ messagesDeleted: 0, crisisEventsDeleted: 0 });
    const sqls = clientQueryMock.mock.calls.map(c => String(c[0]));
    expect(sqls).toEqual(['BEGIN', expect.stringContaining('SELECT tm.message_id'), 'COMMIT']);
  });

  it('rolls the whole deletion back when the audit insert fails (never deletes unaudited)', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ message_id: '11' }] }) // aged select
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // null crisis_event_id
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // delete crisis_events
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // delete thread_messages
      .mockRejectedValueOnce(new Error('data_deletion_log CHECK violation')) // audit insert
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(deleteAgedThreadMessages(DELETE_INPUT)).rejects.toThrow('CHECK violation');
    const sqls = clientQueryMock.mock.calls.map(c => String(c[0]));
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });
});

describe('wipeAgedThreadMessageBodies', () => {
  it('blanks bodies past the cutoff, sandbox-exempt, keeping the row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const cutoff = new Date('2026-08-26T00:00:00Z');

    const wiped = await wipeAgedThreadMessageBodies(cutoff, true);

    expect(wiped).toBe(3);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain(`SET body = ''`);
    expect(sql).not.toContain('DELETE');
    expect(sql).toContain(`tm.body <> ''`);
    expect(sql).toContain('tm.created_at < $1');
    expect(sql).toContain('mt.is_sandbox IS NOT TRUE');
    expect(sql).toContain('cu.is_sandbox');
    // Scan-settled guard (analog of require_redaction_complete).
    expect(sql).toContain(`tm.scan_status <> 'pending'`);
    expect(params).toEqual([cutoff]);
  });

  it('drops the scan-settled guard when require_redaction_complete is off', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await wipeAgedThreadMessageBodies(new Date(), false);

    const [sql] = queryMock.mock.calls[0];
    expect(sql).not.toContain('scan_status');
  });
});

describe('getMessageHistoryForClient', () => {
  it('is scoped by client_id and exposes participant-tier fields only (no risk scores)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        thread_id: 1,
        clinician_role: 'caseworker',
        status: 'active',
        created_at: '2026-08-01',
        last_message_at: '2026-08-02',
        messages: [{ message_id: 5, sender_role: 'participant', body: 'hi', created_at: '2026-08-02', flagged: false }],
      }],
    });

    const threads = await getMessageHistoryForClient(42);

    expect(threads).toHaveLength(1);
    expect(threads[0].messages[0].body).toBe('hi');
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual([42]);
    expect(sql).toContain('WHERE mt.client_id = $1');
    // Participant payload rule: never risk_score/risk_severity, just the flag.
    expect(sql).not.toContain('risk_score');
    expect(sql).not.toContain('risk_severity');
    expect(sql).toContain(`'flagged', tm.scan_status = 'flagged'`);
  });
});
