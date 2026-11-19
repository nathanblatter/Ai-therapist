// Listing and re-checking errored leak checks (ai-therapist-288). The real SQL
// runs in db/leakCheck.queries.live.test.ts; here: the listing never reads
// message text, the cost estimate, and that re-checking skips reviewed rows
// and calls the verifier once per session. No OpenAI client is ever built.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, verifyMock } = vi.hoisted(() => ({ queryMock: vi.fn(), verifyMock: vi.fn() }));
vi.mock('../config/db.js', () => ({ pool: { query: queryMock, on: vi.fn() } }));
vi.mock('./redactionVerifier.service.js', () => ({
  DECISIONS_MODEL: 'gpt-6-luna',
  RESPONSES_MODEL: 'gpt-5-mini',
  verifyRedactedMessages: verifyMock,
}));

const { listErroredLeakChecks, estimateRecheckCost, summarizeErrored, recheckErroredLeakChecks } = await import(
  './leakCheckRecheck.service.js'
);

const row = (id: number, session: string, extra: Record<string, unknown> = {}) => ({
  message_id: id,
  session_id: session,
  message_created_at: `2026-11-0${id}T00:00:00`,
  checked_at: null,
  error: '400 Missing required parameter: questions.',
  reviewed: false,
  chars: 400,
  ...extra,
});

beforeEach(() => {
  queryMock.mockReset();
  verifyMock.mockReset();
});

describe('listErroredLeakChecks', () => {
  it('selects metadata and the text length only, never content or content_redacted itself', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...row(1, 's'), message_id: '1', chars: '400' }] });
    const rows = await listErroredLeakChecks({ sessionId: 's', limit: 5 });
    expect(rows[0]).toMatchObject({ message_id: 1, chars: 400 });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    const select = sql.slice(0, sql.indexOf('FROM messages'));
    expect(select).not.toMatch(/m\.content\b|m\.content_redacted\s+AS|m\.content_redacted,/);
    expect(select).toContain('char_length(m.content_redacted)');
    // Both errored shapes: status='errored' and the pre-288 `error` key.
    expect(sql).toContain("->>'status', '') = 'errored'");
    expect(sql).toContain("? 'error'");
    expect(params).toEqual([false, 's', 5]);
  });
});

describe('estimateRecheckCost', () => {
  it('prices each row as prompt overhead plus text tokens on both backends', () => {
    const est = estimateRecheckCost([{ chars: 400 }, { chars: 400 }]);
    expect(est.rows).toBe(2);
    expect(est.inputTokens).toBe(2 * (200 + 100));
    // gpt-6-luna 0.10 / 0.50 per 1M; gpt-5-mini 0.25 / 2 per 1M (utils/backendModels.ts).
    expect(est.decisionsUsd).toBeCloseTo((600 * 0.1 + 2 * 5 * 0.5) / 1e6, 12);
    expect(est.responsesUsd).toBeCloseTo((600 * 0.25 + 2 * 300 * 2) / 1e6, 12);
    expect(est.responsesUsd).toBeGreaterThan(est.decisionsUsd);
  });

  it('is zero for nothing', () => {
    expect(estimateRecheckCost([])).toEqual({ rows: 0, inputTokens: 0, decisionsUsd: 0, responsesUsd: 0 });
  });
});

describe('summarizeErrored', () => {
  it('counts rows, reviewed rows and sessions, and groups by error text', () => {
    const s = summarizeErrored([row(1, 'a'), row(2, 'a'), row(3, 'b', { error: 'timeout', reviewed: true })] as never);
    expect(s).toMatchObject({ total: 3, reviewed: 1, sessions: 2, firstMessageAt: '2026-11-01T00:00:00' });
    expect(s.byError).toEqual([
      { error: '400 Missing required parameter: questions.', count: 2 },
      { error: 'timeout', count: 1 },
    ]);
  });
});

describe('recheckErroredLeakChecks', () => {
  it('skips reviewed rows, calls the verifier once per session with the redacted text, and sums the results', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { message_id: '1', content_redacted: 'r1' },
          { message_id: '2', content_redacted: 'r2' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ message_id: '4', content_redacted: 'r4' }] });
    verifyMock
      .mockResolvedValueOnce({ checked: 1, flagged: 1, errored: 1 })
      .mockResolvedValueOnce({ checked: 1, flagged: 0, errored: 0 });
    const result = await recheckErroredLeakChecks([
      row(1, 'a'),
      row(2, 'a'),
      row(3, 'b', { reviewed: true }),
      row(4, 'c'),
    ] as never);
    expect(verifyMock.mock.calls).toEqual([
      [
        'a',
        [
          { id: 1, text: 'r1' },
          { id: 2, text: 'r2' },
        ],
      ],
      ['c', [{ id: 4, text: 'r4' }]],
    ]);
    expect(queryMock.mock.calls.map((c) => c[1])).toEqual([[[1, 2]], [[4]]]);
    expect(result).toEqual({ checked: 2, flagged: 1, errored: 1, sessions: 2 });
  });

  it('does nothing for an empty or all-reviewed list', async () => {
    expect(await recheckErroredLeakChecks([row(1, 'a', { reviewed: true })] as never)).toEqual({
      checked: 0,
      flagged: 0,
      errored: 0,
      sessions: 0,
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });
});
