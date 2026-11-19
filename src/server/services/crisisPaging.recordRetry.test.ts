// ai-therapist-369 item 6: a page whose 'crisis_sms_alert' row, or a high flag
// whose crisis event, could not be written used to leave only a log line. The
// write is retried in the background (the page never waits for it) and, if it
// never lands, the admin dashboards are told. Fake clock, fake pool, fake
// pager: nothing here can page anyone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  pager: vi.fn(async (_message: string) => true),
  query: vi.fn(),
  connect: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../config/db.js', () => ({ pool: { query: m.query, connect: m.connect } }));
vi.mock('./crisisAlert.service.js', async () =>
  (await import('../testing/alertMock.js')).alertModuleMock((message: string) => m.pager(message)),
);
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => null) }));

const paging = await import('./crisisPaging.service.js');
const { flagSessionCrisis } = await import('./crisisDetection.service.js');
await import('./suppression.js');

const SESSION = 'chat_retry_0123456789';
const sqlOf = (sql: unknown): string =>
  typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
const isPageRecord = (sql: unknown, params?: unknown[]) =>
  sqlOf(sql).includes('INSERT INTO intervention_actions') && params?.[1] === 'crisis_sms_alert';
const pageRecordAttempts = () => m.query.mock.calls.filter(([sql, params]) => isPageRecord(sql, params)).length;
const unrecordedNotices = () =>
  m.emit.mock.calls.filter(
    ([event, payload]) =>
      event === 'session:page-decision' && (payload as { outcome?: string })?.outcome === 'unrecorded',
  );

/** Let real I/O (a dynamic import) finish between fake-clock steps. */
const realTurn = (): Promise<void> => new Promise((r) => setImmediate(r));
async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) {
    for (let i = 0; i < 3; i++) await realTurn();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  for (let i = 0; i < 3; i++) await realTurn();
}

let failRecords = 0;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  paging._resetPagingStateForTests();
  failRecords = 0;
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: m.emit })) };
  m.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    if (isPageRecord(sql, params)) {
      if (failRecords > 0) {
        failRecords--;
        throw new Error('timeout exceeded when trying to connect');
      }
      return { rows: [{ action_id: 77 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});
afterEach(() => {
  paging._resetPagingStateForTests();
  vi.useRealTimers();
});

describe('the record of a page', () => {
  it('a failed write does not hold the page back, and is retried until it lands', async () => {
    failRecords = 2;
    const decision = await paging.pageHighRisk(SESSION, 90, { source: 'participant_turn' });
    expect(decision.outcome).toBe('paged');
    expect(m.pager).toHaveBeenCalledTimes(1);
    expect(pageRecordAttempts()).toBe(1);
    expect(paging._pendingRecordRetriesForTests()).toBe(1);

    await advance(paging.RECORD_RETRY_DELAYS_MS[0]);
    expect(pageRecordAttempts()).toBe(2);
    await advance(paging.RECORD_RETRY_DELAYS_MS[1]);
    expect(pageRecordAttempts()).toBe(3);
    // Written on the second retry: no more attempts, nothing to report.
    await advance(paging.RECORD_RETRY_DELAYS_MS[2]);
    expect(pageRecordAttempts()).toBe(3);
    expect(paging._pendingRecordRetriesForTests()).toBe(0);
    expect(unrecordedNotices()).toHaveLength(0);
    // The same row each time: the retry writes what the first attempt would have.
    const rows = m.query.mock.calls.filter(([sql, params]) => isPageRecord(sql, params)).map((c) => c[1]);
    expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('a record that never lands is reported to the admin dashboards, once', async () => {
    failRecords = 100;
    await paging.pageHighRisk(SESSION, 90, { source: 'participant_turn' });
    const total = paging.RECORD_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    await advance(total - 1_000);
    expect(unrecordedNotices()).toHaveLength(0);
    await advance(2_000);
    expect(pageRecordAttempts()).toBe(1 + paging.RECORD_RETRY_DELAYS_MS.length);
    expect(unrecordedNotices()).toHaveLength(1);
    const notice = unrecordedNotices()[0][1] as { sessionId: string; message: string };
    expect(notice.sessionId).toBe(SESSION);
    expect(notice.message).toMatch(/NOT RECORDED: the page record/);
    expect(notice.message).toMatch(/high risk flag, score 90\/100/);
    await advance(300_000);
    expect(unrecordedNotices()).toHaveLength(1);
  });

  it('a later page for the same participant still folds into it while its record is pending', async () => {
    failRecords = 1;
    await paging.pageHighRisk(SESSION, 90, { source: 'participant_turn' });
    const again = await paging.pageHighRisk(SESSION, 90, { source: 'participant_turn' });
    expect(again.outcome).toBe('folded');
    expect(m.pager).toHaveBeenCalledTimes(1);
  });
});

describe('a high flag written on retry never lowers the stored score', () => {
  it('the retry keeps the higher score already on the session row', async () => {
    const statements: string[] = [];
    m.connect.mockResolvedValue({
      query: vi.fn(async (sql: unknown) => {
        statements.push(sqlOf(sql));
        return { rows: [{ event_id: 1 }], rowCount: 1 };
      }),
      release: vi.fn(),
    });
    await flagSessionCrisis(SESSION, 'high', 80, 'system', 'auto', null, [], null, { retry: true });
    const update = statements.find((s) => s.includes('UPDATE therapy_sessions'));
    expect(update).toMatch(/GREATEST\(COALESCE\(crisis_risk_score, 0\), \$3\)/);

    statements.length = 0;
    await flagSessionCrisis(SESSION, 'high', 80, 'system', 'auto', null, [], null);
    expect(statements.find((s) => s.includes('UPDATE therapy_sessions'))).not.toMatch(/GREATEST/);
  });
});

// ai-therapist-369 item 3: the page the vendor ceiling sends when the
// session's crisis state could not be read.
describe('vendor ceiling page by where the crisis state came from', () => {
  it('in_process: the high page, saying the stored state could not be read', async () => {
    const decision = await paging.pageVendorTermination({
      sessionId: SESSION,
      cause: 'expired',
      flagged: true,
      severity: 'high',
      stateSource: 'in_process',
    });
    expect(decision).toMatchObject({ outcome: 'paged', level: paging.PAGE_LEVEL.high });
    const text = m.pager.mock.calls[0][0];
    expect(text).toMatch(
      /^URGENT: AI-Therapist voice session hit the vendor session ceiling during a HIGH crisis flag/,
    );
    expect(text).toContain('this server had handled a high-risk turn in it');
  });

  it('unknown: the lowest level, saying plainly that the state could not be read', async () => {
    const decision = await paging.pageVendorTermination({
      sessionId: SESSION,
      cause: 'expired',
      flagged: false,
      severity: null,
      stateSource: 'unknown',
    });
    expect(decision).toMatchObject({ outcome: 'paged', level: paging.PAGE_LEVEL.mediumVendorCut });
    const text = m.pager.mock.calls[0][0];
    expect(text).toMatch(/crisis state could NOT be read/);
    expect(text).not.toMatch(/during a HIGH crisis flag/);
  });

  it('database (the usual case): the page is unchanged', async () => {
    await paging.pageVendorTermination({ sessionId: SESSION, cause: 'expired', flagged: true, severity: 'high' });
    expect(m.pager.mock.calls[0][0]).toBe(
      paging.buildVendorCeilingMessage(SESSION, { previousPage: null, now: Date.now() }),
    );
  });
});
