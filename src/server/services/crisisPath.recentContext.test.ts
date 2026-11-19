// ai-therapist-373 item 1: recent context never depends on the database.
//
// Sibling of crisisPath.pageLatency.test.ts, with the same fakes: every
// crisis-path caller runs for real; only the pool, the model API and the pager
// are fakes, and the clock is fake. Three database regimes:
//
//   refused    every pool call rejects at once;
//   acquire    every pool call rejects after the 3 s connection limit;
//   statement  every statement runs 10 s and is then cancelled (57014).
//
// The assessor fake answers from what it is SHOWN, like the real one: it
// scores the turn high only when its prompt holds the context the reading
// depends on (the whole sentence "... how I would kill myself", or the
// assistant's "Are you thinking about suicide?" before a "yes", or the
// check-in before a "hi"). Before ai-therapist-373 the history came from the
// database alone, so in all three regimes it saw the fragment or the "yes" on
// its own and nobody was paged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state, pool, assessorPrompts } = vi.hoisted(() => {
  const state = { mode: 'acquire' as 'refused' | 'acquire' | 'statement' };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const statementTimeout = () =>
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  const fakeClient = {
    query: async (sql: unknown) => {
      const text = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
      await delay(10_000);
      throw statementTimeout();
    },
    release: () => undefined,
  };
  const pool = {
    query: async () => {
      if (state.mode === 'refused') throw refused();
      if (state.mode === 'acquire') {
        await delay(3_000);
        throw new Error('timeout exceeded when trying to connect');
      }
      await delay(10_000);
      throw statementTimeout();
    },
    connect: async () => {
      if (state.mode === 'refused') throw refused();
      if (state.mode === 'acquire') {
        await delay(3_000);
        throw new Error('timeout exceeded when trying to connect');
      }
      return fakeClient;
    },
  };
  return { state, pool, assessorPrompts: [] as string[] };
});

const pager = vi.fn(async (_message: string) => true);

/** The fake assessor: high only when the prompt carries the context. */
function verdictFor(prompt: string): Record<string, unknown> {
  const base = { reasoning: 'test', states_intent: false, acute: 'none', loss_or_disclosure: false };
  if (/never kill myself/.test(prompt)) {
    return { ...base, risk_score: 0, severity: 'none', context: 'negated', factors: [] };
  }
  if (/how I would kill myself/.test(prompt)) {
    return { ...base, risk_score: 85, severity: 'high', context: 'genuine', factors: ['intent'], states_intent: true };
  }
  if (/Are you thinking about suicide\?/.test(prompt) && /\byes\b/i.test(prompt)) {
    return { ...base, risk_score: 75, severity: 'high', context: 'genuine', factors: ['affirms ideation'] };
  }
  if (/don't really want to be alive/.test(prompt) && /\bhi\b/.test(prompt)) {
    return { ...base, risk_score: 70, severity: 'high', context: 'genuine', factors: ['check-in ideation'] };
  }
  return { ...base, risk_score: 10, severity: 'none', context: 'genuine', factors: [] };
}

vi.mock('../config/db.js', () => ({ pool }));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async (args: unknown) => {
          const prompt = JSON.stringify(args);
          assessorPrompts.push(prompt);
          return { choices: [{ message: { content: JSON.stringify(verdictFor(prompt)) }, finish_reason: 'stop' }] };
        }),
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

const { runCrisisPipeline, _resetEarlyPageStateForTests } = await import('./crisisPipeline.service.js');
const crisisPaging = await import('./crisisPaging.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { _settleBackgroundForTests } = await import('../utils/backgroundWork.js');
const { rememberSessionStart, rememberTurn, _resetRecentTurnsForTests } = await import('../utils/recentTurns.js');
const { rememberSessionAccount, _forgetSessionAccountsForTests } = await import('../utils/sessionAccounts.js');
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

const realTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Run the turn to the end on the fake clock; the fake ms until the first
 *  page, or null when nobody was paged. */
async function runTurn(work: Promise<unknown>, limitMs = 400_000): Promise<number | null> {
  const start = Date.now();
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  void work.then(markSettled, markSettled);
  let pagedAfter: number | null = null;
  while (!settled && Date.now() - start < limitMs) {
    for (let i = 0; i < 5; i++) await realTurn();
    await vi.advanceTimersByTimeAsync(50);
    if (pagedAfter === null && pager.mock.calls.length > 0) pagedAfter = Date.now() - start;
  }
  // The page itself runs in the background after the turn's own work.
  for (let i = 0; i < 400 && pagedAfter === null; i++) {
    for (let j = 0; j < 5; j++) await realTurn();
    await vi.advanceTimersByTimeAsync(50);
    if (pager.mock.calls.length > 0) pagedAfter = Date.now() - start;
  }
  return pagedAfter;
}

/** A voice session that started in this process. */
function startVoiceSession(sessionId: string): void {
  rememberSessionAccount(sessionId, 'participant');
  rememberSessionStart(sessionId);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  pager.mockClear();
  assessorPrompts.length = 0;
  crisisPaging._resetPagingStateForTests();
  _resetEarlyPageStateForTests();
  _resetRecentTurnsForTests();
  _forgetSessionAccountsForTests();
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit: vi.fn() })) };
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(400_000);
  await _settleBackgroundForTests();
  vi.useRealTimers();
});

describe.each(['refused', 'acquire', 'statement'] as const)('every database call fails or stalls: %s', (mode) => {
  it('a sentence split across two voice fragments ("... how I would kill" + " myself") pages', async () => {
    state.mode = mode;
    const sessionId = `ctx_split_${mode}`;
    startVoiceSession(sessionId);
    rememberTurn(sessionId, 'assistant', 'What has been on your mind this week?');
    // What the sideband does with each fragment as it closes: keeps it, then
    // scores it (the insert fails, so no message id). The second fragment
    // closes a second after the first, while the first is still being scored.
    rememberTurn(sessionId, 'user', 'I have been thinking about how I would kill');
    const first = runCrisisPipeline(
      { sessionId, messageId: null, content: 'I have been thinking about how I would kill' },
      'realtime',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    rememberTurn(sessionId, 'user', ' myself');
    const ms = await runTurn(
      Promise.all([first, runCrisisPipeline({ sessionId, messageId: null, content: ' myself' }, 'realtime')]),
    );

    expect(ms).not.toBeNull();
    expect(pager).toHaveBeenCalledTimes(1);
    expect(String(pager.mock.calls[0][0])).toContain('HIGH crisis flag');
    expect(assessorPrompts.some((p) => p.includes('how I would kill myself'))).toBe(true);
    console.log(`[context] ${mode}: split disclosure paged after ${ms} ms`);
    // The same bound as a whole sentence (crisisPath.pageLatency.test.ts).
    expect(ms).toBeLessThanOrEqual(6_000);
  });

  it('the turn was stored but the history read fails: the split sentence is found in memory by its words', async () => {
    state.mode = mode;
    const sessionId = `ctx_split_stored_${mode}`;
    startVoiceSession(sessionId);
    rememberTurn(sessionId, 'user', 'I have been thinking about how I would kill', { messageId: 6 });
    vi.advanceTimersByTime(1_000);
    rememberTurn(sessionId, 'user', ' myself');
    const ms = await runTurn(runCrisisPipeline({ sessionId, messageId: 7, content: ' myself' }, 'realtime'));
    expect(ms).not.toBeNull();
    expect(assessorPrompts.some((p) => p.includes('how I would kill myself'))).toBe(true);
  });

  it('a bare "yes" to the assistant\'s "Are you thinking about suicide?" pages (chat)', async () => {
    state.mode = mode;
    const sessionId = `chat_ctx_yes_${mode}`;
    rememberSessionAccount(sessionId, 'participant');
    rememberSessionStart(sessionId);
    rememberTurn(sessionId, 'user', 'everything feels pointless lately');
    rememberTurn(sessionId, 'assistant', "I'm glad you told me. Are you thinking about suicide?");
    rememberTurn(sessionId, 'user', 'yes');
    const ms = await runTurn(runCrisisPipeline({ sessionId, messageId: null, content: 'yes' }, 'chat'));

    expect(ms).not.toBeNull();
    expect(pager).toHaveBeenCalledTimes(1);
    console.log(`[context] ${mode}: "yes" to a safety question paged after ${ms} ms`);
    expect(ms).toBeLessThanOrEqual(6_000);
  });

  it('a risk check-in followed by "hi" pages: the check-in kept at session start is read', async () => {
    state.mode = mode;
    const sessionId = `chat_ctx_checkin_${mode}`;
    rememberSessionAccount(sessionId, 'participant');
    rememberSessionStart(sessionId, { topic: "I don't really want to be alive" });
    rememberTurn(sessionId, 'user', 'hi');
    const ms = await runTurn(runCrisisPipeline({ sessionId, messageId: null, content: 'hi' }, 'chat'));
    expect(ms).not.toBeNull();
    expect(assessorPrompts.some((p) => p.includes('pre-session check-in form'))).toBe(true);
  });

  describe('nothing in memory either (a restart, another instance): the context-blind rule', () => {
    it('a turn whose own words carry risk, read low without its context, is raised to the page line', async () => {
      state.mode = mode;
      const ms = await runTurn(
        runCrisisPipeline(
          { sessionId: `chat_blind_kw_${mode}`, messageId: null, content: 'sometimes I think about killing myself' },
          'chat',
        ),
      );
      expect(ms).not.toBeNull();
      expect(String(pager.mock.calls[0][0])).toContain('RISK SCORE 65/100');
    });

    it('an ordinary message is not paged', async () => {
      state.mode = mode;
      const ms = await runTurn(
        runCrisisPipeline(
          { sessionId: `chat_blind_plain_${mode}`, messageId: null, content: 'work was long today' },
          'chat',
        ),
      );
      expect(ms).toBeNull();
    });

    it('a negation is not paged: the assessor settles it on its own words', async () => {
      state.mode = mode;
      const ms = await runTurn(
        runCrisisPipeline(
          { sessionId: `chat_blind_neg_${mode}`, messageId: null, content: 'I would never kill myself' },
          'chat',
        ),
      );
      expect(assessorPrompts.some((p) => p.includes('never kill myself'))).toBe(true);
      expect(ms).toBeNull();
    });

    it('knowingly not covered: a bare "yes" or a lone fragment, with nothing kept to say what it answers', async () => {
      state.mode = mode;
      const yes = await runTurn(
        runCrisisPipeline({ sessionId: `chat_blind_yes_${mode}`, messageId: null, content: 'yes' }, 'chat'),
      );
      const fragment = await runTurn(
        runCrisisPipeline({ sessionId: `live_blind_frag_${mode}`, messageId: null, content: ' myself' }, 'realtime'),
      );
      expect(yes).toBeNull();
      expect(fragment).toBeNull();
    });
  });
});
