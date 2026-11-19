// Structural guarantees of the researcher semantic search (ai-therapist-177):
// the query can only ever read content_redacted, every hit must satisfy the
// redaction-complete predicate, and rows leave through an explicit projection
// so a raw column could not ride along even if the SELECT were widened.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));
  return { clientQueryMock, releaseMock, connectMock };
});
vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn(), connect: connectMock, on: vi.fn() },
}));

import {
  redactionCompleteSql,
  searchRedactedMessages,
  semanticSearchSql,
  semanticSearchCandidates,
  SEMANTIC_SEARCH_MAX_WINDOW,
} from './semanticSearch.queries.js';

const BASE = { embedding: [0.5, -0.25], orgId: 1, minSimilarity: 0.3, limit: 2, offset: 0 };

function dbRow(id: number, extra: Record<string, unknown> = {}) {
  return {
    message_id: String(id),
    session_id: 'sess-1',
    role: 'user',
    redacted_text: `[NAME] cannot sleep ${id}`,
    created_at: '2026-11-01 10:00:00+00',
    similarity: '0.61',
    session_name: 'Sleep worries',
    session_started_at: '2026-11-01 09:00:00+00',
    owner_user_id: 42,
    ...extra,
  };
}

function searchCall(): [string, unknown[]] {
  const call = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('redacted_text'));
  if (!call) throw new Error('search query not issued');
  return call as [string, unknown[]];
}

beforeEach(() => {
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  clientQueryMock.mockImplementation(async (sql: string) =>
    String(sql).includes('redacted_text') ? { rows: [dbRow(1), dbRow(2)] } : { rows: [] },
  );
});

describe.each(['index', 'exact'] as const)('semanticSearchSql(%s) (structural)', (mode) => {
  const SEMANTIC_SEARCH_SQL = semanticSearchSql(mode);
  const outerSelect = SEMANTIC_SEARCH_SQL.indexOf('SELECT m.message_id');
  const selectList = SEMANTIC_SEARCH_SQL.slice(outerSelect, SEMANTIC_SEARCH_SQL.indexOf('FROM', outerSelect));

  it('has exactly one outer SELECT that reads messages columns', () => {
    expect(outerSelect).toBeGreaterThan(-1);
    expect(SEMANTIC_SEARCH_SQL.match(/SELECT m\./g)).toHaveLength(1);
  });

  it('never references the raw content column anywhere in the query', () => {
    // \bcontent\b does not match content_redacted (underscore is a word char).
    expect(SEMANTIC_SEARCH_SQL).not.toMatch(/\bcontent\b/);
  });

  it('selects content_redacted as the only text and no metadata blob', () => {
    expect(selectList).toMatch(/m\.content_redacted AS redacted_text/);
    expect(selectList).not.toMatch(/metadata/);
    expect(selectList).not.toMatch(/\*/);
  });

  it('requires the redaction-complete predicate on every hit', () => {
    expect(SEMANTIC_SEARCH_SQL).toContain(redactionCompleteSql('m'));
  });

  it('never returns rows from active sessions, demo sessions or sandbox accounts', () => {
    expect(SEMANTIC_SEARCH_SQL).toMatch(/ts\.status <> 'active'/);
    expect(SEMANTIC_SEARCH_SQL).toMatch(/ts\.is_demo IS NOT TRUE/);
    expect(SEMANTIC_SEARCH_SQL).toMatch(/u\.is_sandbox IS NOT TRUE/);
  });

  it("is always scoped to the caller's organization (anonymous sessions: irb-study only)", () => {
    expect(SEMANTIC_SEARCH_SQL).toMatch(/ou\.organization_id = \$2::int/);
    expect(SEMANTIC_SEARCH_SQL).toMatch(/ts\.user_id IS NULL AND \$2::int = \(SELECT org_id FROM organizations/);
  });

  it('pages by cosine distance with the cutoff applied', () => {
    expect(SEMANTIC_SEARCH_SQL).toMatch(/m\.embedding IS NOT NULL/);
    expect(SEMANTIC_SEARCH_SQL).toMatch(/<= \$6::float8\s+ORDER BY \S+.*\s+LIMIT \$7 OFFSET \$8/);
  });
});

describe('semanticSearchSql plan shapes', () => {
  it('index mode: a materialized candidate pool ordered only by the cosine operator, under the partial index predicate', () => {
    const sql = semanticSearchSql('index');
    expect(sql).toMatch(
      /WITH candidates AS MATERIALIZED \(\s+SELECT c\.message_id, c\.embedding <=> \$1::vector AS distance\s+FROM messages c\s+WHERE c\.embedding IS NOT NULL\s+ORDER BY c\.embedding <=> \$1::vector\s+LIMIT \$9\s+\)/,
    );
    expect(sql).toMatch(/ORDER BY cand\.distance\s+LIMIT \$7 OFFSET \$8/);
  });

  it('exact mode: ranks the filtered rows directly, with no pool bound', () => {
    const sql = semanticSearchSql('exact');
    expect(sql).not.toMatch(/candidates|\$9/);
    expect(sql).toMatch(/ORDER BY \(m\.embedding <=> \$1::vector\)\s+LIMIT \$7 OFFSET \$8/);
  });
});

describe('semanticSearchCandidates', () => {
  it('is 4x the page window, at least 200 and at most 1000', () => {
    expect(semanticSearchCandidates(25, 0)).toBe(200);
    expect(semanticSearchCandidates(50, 50)).toBe(404);
    expect(semanticSearchCandidates(50, 150)).toBe(804);
    expect(semanticSearchCandidates(500, 0)).toBe(1000);
  });
});

describe('redactionCompleteSql', () => {
  const sql = redactionCompleteSql('m');

  it('admits only participant/model turns with non-blank redacted text', () => {
    expect(sql).toMatch(/m\.role IN \('user', 'assistant'\)/);
    expect(sql).toMatch(/m\.content_redacted IS NOT NULL/);
    expect(sql).toMatch(/btrim\(m\.content_redacted\) <> ''/);
  });

  it('excludes rows whose redaction run recorded an error', () => {
    expect(sql).toMatch(/\(m\.metadata->>'redaction_error'\) IS NULL/);
  });

  it('excludes leak-check-flagged rows until a researcher has reviewed them', () => {
    expect(sql).toMatch(/redaction_check'->>'flagged', 'false'\) = 'true'/);
    expect(sql).toMatch(/redaction_check'->>'reviewed', 'false'\) = 'true'/);
    expect(sql).toMatch(/AND NOT \(/);
  });

  // ai-therapist-288: an errored check is unverified, not clean; it is gated like a flagged one.
  it('excludes rows whose leak check errored, in both the status and the pre-288 shape, until reviewed', () => {
    expect(sql).toMatch(/m\.metadata->'redaction_check'->>'status', ''\) = 'errored'/);
    expect(sql).toMatch(/m\.metadata->'redaction_check' \? 'error'/);
  });
});

describe('searchRedactedMessages', () => {
  it('study-wide: index mode in a read-only transaction with ef_search matching the pool', async () => {
    await searchRedactedMessages({ ...BASE, limit: 50, offset: 150 });
    const sqls = clientQueryMock.mock.calls.map(([s]) => String(s).trim().split('\n')[0].trim());
    expect(sqls[0]).toBe('BEGIN READ ONLY');
    expect(sqls[1]).toBe('SET LOCAL hnsw.ef_search = 804');
    expect(sqls[2]).toMatch(/^WITH candidates AS MATERIALIZED/);
    expect(sqls[3]).toBe('COMMIT');
    const [, params] = searchCall();
    expect(params).toEqual(['[0.5,-0.25]', 1, null, null, null, 0.7, 51, 150, 804]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('one session: exact mode binds vector, org, filters, distance cutoff and limit+1, no ef_search', async () => {
    await searchRedactedMessages({
      ...BASE,
      sessionId: 'sess-1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      minSimilarity: 0.4,
      offset: 4,
    });
    const [, params] = searchCall();
    expect(params).toEqual([
      '[0.5,-0.25]',
      1,
      'sess-1',
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      0.6,
      3,
      4,
    ]);
    const sqls = clientQueryMock.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => s.includes('ef_search'))).toBe(false);
    expect(sqls.some((s) => s.includes('candidates'))).toBe(false);
  });

  it('reports hasMore from the extra row and trims it', async () => {
    clientQueryMock.mockImplementation(async (sql: string) =>
      String(sql).includes('redacted_text') ? { rows: [dbRow(1), dbRow(2), dbRow(3)] } : { rows: [] },
    );
    const page = await searchRedactedMessages(BASE);
    expect(page.hasMore).toBe(true);
    expect(page.hits.map((h) => h.messageId)).toEqual(['1', '2']);
  });

  it('projects explicit fields only: raw content or metadata on a row can never leave', async () => {
    clientQueryMock.mockImplementation(async (sql: string) =>
      String(sql).includes('redacted_text')
        ? {
            rows: [
              dbRow(1, {
                content: 'RAW Alice Smith cannot sleep',
                metadata: { arguments: 'RAW Alice Smith' },
                extras: 'RAW',
              }),
            ],
          }
        : { rows: [] },
    );
    const page = await searchRedactedMessages(BASE);
    expect(Object.keys(page.hits[0]).sort()).toEqual(
      [
        'createdAt',
        'messageId',
        'ownerUserId',
        'role',
        'sessionId',
        'sessionName',
        'sessionStartedAt',
        'similarity',
        'text',
      ].sort(),
    );
    expect(page.hits[0].text).toBe('[NAME] cannot sleep 1');
    expect(JSON.stringify(page)).not.toContain('RAW');
    expect(page.hits[0].similarity).toBe(0.61);
  });

  it('refuses a window past the cap without touching the pool', async () => {
    await expect(searchRedactedMessages({ ...BASE, limit: 50, offset: SEMANTIC_SEARCH_MAX_WINDOW })).rejects.toThrow(
      /window/,
    );
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rolls back and releases on a query error', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('redacted_text')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(searchRedactedMessages(BASE)).rejects.toThrow('boom');
    expect(clientQueryMock.mock.calls.map(([s]) => String(s))).toContain('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
