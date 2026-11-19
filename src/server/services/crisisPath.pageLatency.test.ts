// ai-therapist-369 item 2: how long a person at risk waits for the on-call to
// be paged when the database is slow. Every crisis-path caller runs for real;
// only the pool, the model API and the pager are fakes, and the clock is fake,
// so the numbers below are the code's own worst case, not this machine's speed.
//
// Two regimes, the two failures the pool bounds of PR #81 produce:
//
//   acquire    no connection is free: every pool.query and pool.connect
//              rejects after DB_CONNECTION_TIMEOUT_MS (3 s);
//   statement  a connection is free but every statement runs for
//              DB_STATEMENT_TIMEOUT_MS (10 s) and is then cancelled (57014).
//
// The risk assessor answers at once with a high verdict (the model is not what
// is measured here). The page is "requested" when the paging layer's SMS
// transport is called: that is the moment the on-call's phone is texted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state, pool, assessment } = vi.hoisted(() => {
  const state = { mode: 'acquire' as 'acquire' | 'statement', calls: [] as Array<{ at: number; sql: string }> };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const statementTimeout = () =>
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const note = (sql: unknown) => {
    const text = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
    state.calls.push({ at: Date.now(), sql: text.trim().replace(/\s+/g, ' ').slice(0, 60) });
    return text;
  };
  const fakeClient = {
    query: async (sql: unknown) => {
      const text = note(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
      await delay(10_000);
      throw statementTimeout();
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: unknown) => {
      note(sql);
      if (state.mode === 'acquire') {
        await delay(3_000);
        throw new Error('timeout exceeded when trying to connect');
      }
      await delay(10_000);
      throw statementTimeout();
    },
    connect: async () => {
      if (state.mode === 'acquire') {
        note('connect');
        await delay(3_000);
        throw new Error('timeout exceeded when trying to connect');
      }
      return fakeClient;
    },
  };
  const assessment = {
    value: {
      risk_score: 85,
      severity: 'high',
      context: 'genuine',
      factors: ['stated intent'],
      reasoning: 'test',
      states_intent: true,
      acute: 'none',
    } as Record<string, unknown>,
  };
  return { state, pool, assessment };
});

const pager = vi.fn(async (_message: string) => true);

vi.mock('../config/db.js', () => ({ pool }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: JSON.stringify(assessment.value) }, finish_reason: 'stop' }],
        })),
      },
    };
    moderations = {
      create: vi.fn(async () => ({ results: [{ flagged: false, categories: {}, category_scores: {} }] })),
    };
  },
}));
vi.mock('./crisisAlert.service.js', async () => ({
  ...(await import('../testing/alertMock.js')).alertModuleMock((m: string) => pager(m)),
  reportOpenAIQuotaExhausted: vi.fn(async () => true),
  reportRiskAssessorOutage: vi.fn(async () => true),
}));
vi.mock('./sidebandManager.service.js', () => ({
  sidebandManager: {
    getActiveConnections: () => [] as string[],
    isConnected: () => false,
    injectMessage: vi.fn(async () => undefined),
    tryInject: vi.fn(async () => false),
    waitForUserTurnsScored: vi.fn(async () => true),
  },
}));
vi.mock('../utils/sessionAutoTerminate.js', () => ({
  liftLimitForCrisis: vi.fn(() => ({ lifted: false, previousLimitMinutes: null, ceilingMinutes: 60 })),
}));
vi.mock('./adverseEvent.service.js', () => ({ draftAdverseEventFromCrisis: vi.fn(async () => null) }));

const { runCrisisPipeline } = await import('./crisisPipeline.service.js');
const crisisPaging = await import('./crisisPaging.service.js');
const { toolRegistry } = await import('./toolRegistry.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
// Everything the crisis path imports lazily, loaded now so a dynamic import is
// never what the fake clock is waiting on.
await import('./moderation.service.js');
await import('./crisisIntervention.service.js');
await import('../utils/sessionHelpers.js');
await import('../utils/safetyIdentifier.js');
await import('./minorSafeguard.service.js');
await import('./riskAssessorHealth.service.js');
await import('./suppression.js');
await import('./crisisAlert.service.js');
await import('../db/paging.queries.js');
await import('./adverseEvent.service.js');
await import('./workQueue.service.js');

/** Let real I/O (a dynamic import resolving) finish before the fake clock
 *  moves on, so the clock never runs ahead of the code. */
const realTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Advance the fake clock in small steps until the pager has been called;
 *  returns the fake milliseconds that took. */
async function msUntilPaged(work: Promise<unknown>, limitMs = 400_000): Promise<number> {
  const start = Date.now();
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  // The escalate tool may be answered with its own timeout while the pool is
  // still slow: that is its documented answer, not a failure here.
  void work.then(markSettled, markSettled);
  while (pager.mock.calls.length === 0) {
    if (Date.now() - start > limitMs) throw new Error(`no page within ${limitMs} ms`);
    for (let i = 0; i < 5; i++) await realTurn();
    await vi.advanceTimersByTimeAsync(50);
  }
  const elapsed = Date.now() - start;
  // Let the rest of the turn finish (it is still waiting on the slow pool).
  while (!settled && Date.now() - start < limitMs) await vi.advanceTimersByTimeAsync(1_000);
  return elapsed;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  pager.mockClear();
  state.calls = [];
  crisisPaging._resetPagingStateForTests();
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(400_000);
  await _settleBackgroundForTests();
  vi.useRealTimers();
});

describe.each(['acquire', 'statement'] as const)('time to page with a slow database: %s', (mode) => {
  it('a high voice turn', async () => {
    state.mode = mode;
    const ms = await msUntilPaged(
      runCrisisPipeline(
        { sessionId: `lat_voice_${mode}`, messageId: 7, content: 'I am going to kill myself' },
        'realtime',
      ),
    );
    console.log(`[latency] ${mode}: high voice turn paged after ${ms} ms (${state.calls.length} pool calls)`);
    // Two rounds of 2 s read deadlines before the verdict (history and
    // check-in; trajectory, session context and the assessor's settings),
    // then the paging layer's own 2 s lookups. Never a pool limit, in either
    // regime. (Before ai-therapist-369: 42 s and 132 s.)
    expect(ms).toBeLessThanOrEqual(6_000);
  });

  it('a high chat turn', async () => {
    state.mode = mode;
    const ms = await msUntilPaged(
      runCrisisPipeline({ sessionId: `lat_chat_${mode}`, messageId: 8, content: 'I am going to kill myself' }, 'chat'),
    );
    console.log(`[latency] ${mode}: high chat turn paged after ${ms} ms`);
    expect(ms).toBeLessThanOrEqual(6_000);
  });

  it('escalate_to_human at high urgency', async () => {
    state.mode = mode;
    const ms = await msUntilPaged(
      toolRegistry.executeTool(
        'escalate_to_human',
        { reason: 'participant describes a plan', urgency: 'high' },
        { sessionId: `lat_esc_${mode}` },
      ),
    );
    console.log(`[latency] ${mode}: escalate_to_human paged after ${ms} ms`);
    // The tool kill switch (a 2 s bounded config read on a cache miss), then
    // the paging layer's own 2 s lookups; the flag write runs alongside.
    // (Before ai-therapist-369: 8 s and 22 s.)
    expect(ms).toBeLessThanOrEqual(4_000);
  });
});
