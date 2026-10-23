// Message data-access (ai-therapist-236 chunk 4): parameter order on insert,
// the content vs content_redacted column choice on read and edit, re-redaction
// on therapist edits only, and the transaction envelopes (COMMIT / ROLLBACK /
// release) around batch insert, update and delete.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, clientQueryMock, releaseMock, connectMock, redactMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));
  return { queryMock: vi.fn(), clientQueryMock, releaseMock, connectMock, redactMock: vi.fn() };
});
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: connectMock, on: vi.fn() } }));
vi.mock('../services/redaction.service.js', () => ({ default: redactMock }));

import {
  insertMessage,
  insertMessagesBatch,
  getSessionMessages,
  getMessageOwner,
  getSessionMessageCount,
  updateMessage,
  deleteMessage,
} from './messages.queries.js';

const ROW = {
  message_id: 1,
  session_id: 's1',
  role: 'user',
  message_type: 'chat',
  content: 'hi',
  content_redacted: 'hi',
  metadata: null,
  created_at: new Date(),
};

function clientSql(): string[] {
  return clientQueryMock.mock.calls.map((c) => (c[0] as string).trim().split(/\s+/)[0]);
}

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  redactMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  clientQueryMock.mockResolvedValue({ rows: [] });
});

describe('insertMessage', () => {
  it('binds the columns in order with a null metadata default', async () => {
    queryMock.mockResolvedValue({ rows: [ROW] });
    await expect(insertMessage('s1', 'user', 'chat', 'raw text', 'redacted text')).resolves.toBe(ROW);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /INSERT INTO messages \(session_id, role, message_type, content, content_redacted, metadata, created_at\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, CURRENT_TIMESTAMP\)\s+RETURNING \*/,
    );
    expect(params).toEqual(['s1', 'user', 'chat', 'raw text', 'redacted text', null]);
  });

  it('passes metadata through when given', async () => {
    await insertMessage('s1', 'assistant', 'voice', null, null, { latency_ms: 12 });
    expect(queryMock.mock.calls[0][1]).toEqual(['s1', 'assistant', 'voice', null, null, { latency_ms: 12 }]);
  });
});

describe('insertMessagesBatch', () => {
  it('inserts every row inside one transaction, defaulting created_at to now', async () => {
    clientQueryMock.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.startsWith('INSERT') ? { rows: [{ ...ROW, content: (params as string[])[3] }] } : { rows: [] },
    );
    const when = new Date('2026-01-01T00:00:00Z');
    const before = Date.now();
    const rows = await insertMessagesBatch([
      {
        session_id: 's1',
        role: 'user',
        message_type: 'chat',
        content: 'one',
        content_redacted: 'one',
        created_at: when,
      },
      { session_id: 's1', role: 'assistant', message_type: 'chat', content: 'two', content_redacted: 'two' },
    ]);
    expect(rows.map((r) => r.content)).toEqual(['one', 'two']);
    expect(clientSql()).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);

    const first = clientQueryMock.mock.calls[1] as [string, unknown[]];
    expect(first[0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)/);
    expect(first[1]).toEqual(['s1', 'user', 'chat', 'one', 'one', undefined, when]);
    const second = clientQueryMock.mock.calls[2] as [string, unknown[]];
    expect(second[1].slice(0, 6)).toEqual(['s1', 'assistant', 'chat', 'two', 'two', undefined]);
    const defaulted = second[1][6] as Date;
    expect(defaulted).toBeInstanceOf(Date);
    expect(defaulted.getTime()).toBeGreaterThanOrEqual(before);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows when any insert fails, and still releases the client', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT')) throw new Error('constraint violated');
      return { rows: [] };
    });
    await expect(
      insertMessagesBatch([
        { session_id: 's1', role: 'user', message_type: 'chat', content: 'x', content_redacted: 'x' },
      ]),
    ).rejects.toThrow('constraint violated');
    expect(clientSql()).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('getSessionMessages', () => {
  it('exposes both columns by default, oldest first', async () => {
    await getSessionMessages('s1');
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/message_type,\s+content, content_redacted,\s+metadata/);
    expect(sql).toMatch(/WHERE session_id = \$1\s+ORDER BY created_at ASC/);
    expect(params).toEqual(['s1']);
  });

  it('aliases the redacted column as content and never selects raw content when redactedOnly', async () => {
    await getSessionMessages('s1', true);
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toMatch(/message_type,\s+content_redacted as content,\s+metadata/);
    expect(sql).not.toMatch(/^\s+content,\s*$/m);
  });
});

describe('getMessageOwner', () => {
  it('resolves the owning session, participant and organization in one query', async () => {
    queryMock.mockResolvedValue({ rows: [{ session_id: 's1', user_id: 42, owner_organization_id: 2 }] });
    await expect(getMessageOwner(9)).resolves.toEqual({ session_id: 's1', user_id: 42, owner_organization_id: 2 });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT m.session_id, ts.user_id, u.organization_id AS owner_organization_id');
    expect(sql).toMatch(
      /LEFT JOIN therapy_sessions ts ON ts\.session_id = m\.session_id\s+LEFT JOIN users u ON u\.userid = ts\.user_id\s+WHERE m\.message_id = \$1/,
    );
    expect(params).toEqual([9]);
  });

  it('returns null for an unknown message', async () => {
    await expect(getMessageOwner('404')).resolves.toBeNull();
  });
});

describe('getSessionMessageCount', () => {
  it('parses the bigint count', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: '17' }] });
    await expect(getSessionMessageCount('s1')).resolves.toBe(17);
    expect(queryMock.mock.calls[0]).toEqual(['SELECT COUNT(*) as count FROM messages WHERE session_id = $1', ['s1']]);
  });
});

describe('updateMessage', () => {
  it('rejects an unknown field before touching the pool', async () => {
    await expect(updateMessage(1, 'x', 'metadata' as 'content', {})).rejects.toThrow(
      'fieldToUpdate must be either "content" or "content_redacted"',
    );
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('therapist edit: re-redacts and writes both columns, merging the edit metadata', async () => {
    redactMock.mockResolvedValue('[NAME] said hi');
    clientQueryMock.mockImplementation(async (sql: string) =>
      sql.startsWith('UPDATE') ? { rows: [ROW] } : { rows: [] },
    );
    const meta = { edited_by: 'dr_t', edited_at: '2026-01-01' };
    await expect(updateMessage(5, 'Alice said hi', 'content', meta)).resolves.toBe(ROW);

    expect(redactMock).toHaveBeenCalledWith('Alice said hi');
    expect(clientSql()).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);
    const [sql, params] = clientQueryMock.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(
      /SET content = \$1,\s+content_redacted = \$2,\s+metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| \$3::jsonb\s+WHERE message_id = \$4\s+RETURNING \*/,
    );
    expect(params).toEqual(['Alice said hi', '[NAME] said hi', JSON.stringify(meta), 5]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('researcher edit: writes only content_redacted and never runs redaction', async () => {
    clientQueryMock.mockImplementation(async (sql: string) =>
      sql.startsWith('UPDATE') ? { rows: [ROW] } : { rows: [] },
    );
    const meta = { edited_by: 'researcher' };
    await updateMessage('5', 'cleaned', 'content_redacted', meta);

    expect(redactMock).not.toHaveBeenCalled();
    const [sql, params] = clientQueryMock.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(
      /SET content_redacted = \$1,\s+metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| \$2::jsonb\s+WHERE message_id = \$3/,
    );
    expect(sql).not.toMatch(/SET content =/);
    expect(params).toEqual(['cleaned', JSON.stringify(meta), '5']);
  });

  it('rolls back when the message does not exist', async () => {
    await expect(updateMessage(404, 'x', 'content_redacted', {})).rejects.toThrow('Message not found');
    expect(clientSql()).toEqual(['BEGIN', 'UPDATE', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('deleteMessage', () => {
  it('deletes inside a transaction after confirming the session keeps at least one message', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT session_id')) return { rows: [{ session_id: 's1' }] };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '2' }] };
      if (sql.startsWith('DELETE')) return { rows: [ROW] };
      return { rows: [] };
    });
    await expect(deleteMessage(1)).resolves.toBe(ROW);
    expect(clientSql()).toEqual(['BEGIN', 'SELECT', 'SELECT', 'DELETE', 'COMMIT']);
    expect(clientQueryMock.mock.calls[1]).toEqual(['SELECT session_id FROM messages WHERE message_id = $1', [1]]);
    expect(clientQueryMock.mock.calls[2]).toEqual([
      'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
      ['s1'],
    ]);
    expect(clientQueryMock.mock.calls[3]).toEqual(['DELETE FROM messages WHERE message_id = $1 RETURNING *', [1]]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete the last message in a session and rolls back', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT session_id')) return { rows: [{ session_id: 's1' }] };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '1' }] };
      return { rows: [] };
    });
    await expect(deleteMessage(1)).rejects.toThrow('Cannot delete the last message in a session');
    expect(clientSql()).toEqual(['BEGIN', 'SELECT', 'SELECT', 'ROLLBACK']);
    expect(clientSql()).not.toContain('DELETE');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back when the message does not exist', async () => {
    await expect(deleteMessage(404)).rejects.toThrow('Message not found');
    expect(clientSql()).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
