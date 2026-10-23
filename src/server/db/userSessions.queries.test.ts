// user_sessions org scoping (ai-therapist-272): both queries join the
// express-session JSON's userId to users and keep the caller's org only;
// sessions with no userId are irb-study custody; the delete is scoped the
// same way so a cross-org sid matches nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, connect: vi.fn(), on: vi.fn() } }));

import { getActiveUserSessions, deleteUserSession } from './userSessions.queries.js';

const IRB = "(SELECT org_id FROM organizations WHERE slug = 'irb-study')";

beforeEach(() => queryMock.mockReset());

function expectScoped(sql: string, orgParam: string) {
  expect(sql).toMatch(/LEFT JOIN users u\s+ON s\.sess->>'userId' ~ '\^\[0-9\]\+\$' AND u\.userid = \(s\.sess->>'userId'\)::int/);
  expect(sql).toContain(`u.organization_id = ${orgParam}`);
  expect(sql).toContain(`s.sess->>'userId' IS NULL AND ${orgParam} = ${IRB}`);
}

describe('getActiveUserSessions', () => {
  it('selects the caller org, anonymous sessions irb-study only, newest expiry first', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ sid: 'a' }] });
    await expect(getActiveUserSessions(2)).resolves.toEqual([{ sid: 'a' }]);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT s\.sid, s\.sess, s\.expire\s+FROM user_sessions s/);
    expectScoped(sql, '$1');
    expect(sql).toMatch(/ORDER BY s\.expire DESC/);
    expect(params).toEqual([2]);
  });
});

describe('deleteUserSession', () => {
  it('deletes only when the sid is inside the caller org scope', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ sid: 'a' }] });
    await expect(deleteUserSession('a', 2)).resolves.toBe('a');
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM user_sessions\s+WHERE sid = \$1\s+AND sid IN \(/);
    expect(sql).toContain('WHERE s.sid = $1 AND');
    expectScoped(sql, '$2');
    expect(sql).toMatch(/RETURNING sid/);
    expect(params).toEqual(['a', 2]);
  });

  it('returns null when nothing matched (missing or out of scope)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(deleteUserSession('zzz', 2)).resolves.toBeNull();
  });
});
