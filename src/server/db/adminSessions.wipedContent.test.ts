// ai-therapist-234: the content-retention wipe nulls raw `content` ~24h after
// a session, so a raw-tier (therapist) transcript read selecting `content`
// alone rendered "(No message content)" for every participant/assistant turn.
// The raw tier now falls back to the redacted copy per row and flags it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));

import { getAdminSessionMessages, messageTextSql } from './adminSessions.queries.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('messageTextSql', () => {
  it('falls back to the redacted copy for raw-tier readers', () => {
    expect(messageTextSql('content')).toBe('COALESCE(content, content_redacted)');
    expect(messageTextSql('content', 'm')).toBe('COALESCE(m.content, m.content_redacted)');
  });

  it('never widens the redacted tier to raw content', () => {
    expect(messageTextSql('content_redacted')).toBe('content_redacted');
    expect(messageTextSql('content_redacted', 'm')).toBe('m.content_redacted');
  });
});

describe('getAdminSessionMessages after the retention wipe', () => {
  it('selects the fallback expression and a content_wiped flag on the raw path', async () => {
    await getAdminSessionMessages('s1', 'content');
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('COALESCE(content, content_redacted) as message');
    expect(sql).toContain('(content IS NULL AND content_redacted IS NOT NULL) as content_wiped');
  });

  it('keeps the redacted path on content_redacted only', async () => {
    await getAdminSessionMessages('s1', 'content_redacted');
    const [sql] = queryMock.mock.calls[0];
    expect(sql).not.toContain('COALESCE');
    expect(sql).toContain('content_redacted as message');
    expect(sql).toContain('FALSE as content_wiped');
  });
});
