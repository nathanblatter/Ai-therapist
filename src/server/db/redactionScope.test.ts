import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/db.js', () => ({
  pool: { query: queryMock, connect: vi.fn(), on: vi.fn() },
}));
vi.mock('../services/redaction.service.js', () => ({
  redactPHIBatch: vi.fn(async () => new Map<number, string>()),
}));

import { redactableRowsSql, REDACTABLE_ROWS_SQL } from './redactionScope.js';
import { getRedactionStatusBreakdown, getRedactionStatus } from './adminSessions.queries.js';
import { redactSession } from '../services/sessionRedaction.service.js';
import { findEndedSessionsWithRedactionGaps } from '../services/contentWipe.service.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('redactableRowsSql', () => {
  it('covers participant and model turns', () => {
    expect(REDACTABLE_ROWS_SQL).toContain("role IN ('user', 'assistant')");
  });

  it('covers tool_event_% rows, which are role=system but hold participant free text', () => {
    expect(REDACTABLE_ROWS_SQL).toContain("message_type LIKE 'tool_event_%'");
  });

  it('is a single OR-ed, parenthesised boolean so it can be AND-ed into any WHERE', () => {
    expect(REDACTABLE_ROWS_SQL.startsWith('(')).toBe(true);
    expect(REDACTABLE_ROWS_SQL.endsWith(')')).toBe(true);
    expect(REDACTABLE_ROWS_SQL).toContain(' OR ');
  });

  it('qualifies every column with the given table alias', () => {
    const aliased = redactableRowsSql('m');
    expect(aliased).toBe("(m.role IN ('user', 'assistant') OR m.message_type LIKE 'tool_event_%')");
  });
});

// ai-therapist-225: the redaction job, the content-wipe sweep and the admin
// status read each carried their own copy of "which rows need redaction". The
// status read was never widened for tool_event_% rows, so the admin UI reported
// 'complete' for sessions whose thought-record and fear-ladder free text was
// still raw. These assert the copies are gone — every one of those queries is
// built from the shared fragment.
describe('redaction-scope agreement across call sites', () => {
  async function sqlOf(run: () => Promise<unknown>, rows: Record<string, string>[] = [{ total: '0', redacted: '0', pending_count: '0' }]): Promise<string> {
    queryMock.mockResolvedValue({ rows });
    await run();
    return String(queryMock.mock.calls[0][0]);
  }

  it('the admin status breakdown scopes its counts with the shared fragment', async () => {
    const sql = await sqlOf(() => getRedactionStatusBreakdown('s1'));
    expect(sql).toContain(REDACTABLE_ROWS_SQL);
    expect(sql).not.toMatch(/FILTER \(WHERE role IN \('user', 'assistant'\) AND/);
  });

  it('the admin pending count scopes with the shared fragment', async () => {
    const sql = await sqlOf(() => getRedactionStatus('s1'));
    expect(sql).toContain(REDACTABLE_ROWS_SQL);
  });

  it('redactSession selects exactly the shared fragment row set', async () => {
    const sql = await sqlOf(() => redactSession('s1'), []);
    expect(sql).toContain(REDACTABLE_ROWS_SQL);
  });

  it('the content-wipe sweep selects the shared fragment row set (aliased)', async () => {
    const sql = await sqlOf(() => findEndedSessionsWithRedactionGaps());
    expect(sql).toContain(redactableRowsSql('m'));
  });

  it('the status read and redactSession agree on the row set', async () => {
    const statusSql = await sqlOf(() => getRedactionStatusBreakdown('s1'));
    queryMock.mockReset();
    const redactSql = await sqlOf(() => redactSession('s1'), []);

    const scopeOf = (sql: string) => sql.match(/\(role IN \([^)]*\) OR message_type LIKE '[^']*'\)/g) ?? [];
    expect(scopeOf(statusSql).length).toBeGreaterThan(0);
    expect(scopeOf(redactSql).length).toBeGreaterThan(0);
    expect(new Set(scopeOf(statusSql))).toEqual(new Set(scopeOf(redactSql)));
  });
});
