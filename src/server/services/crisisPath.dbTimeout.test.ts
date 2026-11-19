// ai-therapist-366: the crisis path against a database whose pool now REJECTS
// where it used to wait forever. Every crisis-path caller runs for real here;
// only the pool, the model API and the pager are fakes. The pool answers every
// request with one of the two errors the bounds produce:
//
//   acquire    pg-pool's "timeout exceeded when trying to connect" (no
//              connection free within connectionTimeoutMillis), from both
//              pool.query and pool.connect;
//   statement  Postgres' 57014 "canceling statement due to statement timeout"
//              on every statement (BEGIN / COMMIT / ROLLBACK still succeed,
//              as they would).
//
// For each, a high-risk turn, the escalate tool, the paging entry points and
// the silence-check sweep must end in a page and (where there is a participant
// screen) the crisis resources, never in silence or an unhandled rejection.
// Nothing here can page anyone: the pager is a mock, and no network is used.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Mode = 'acquire' | 'statement';

const { state, fakeClient } = vi.hoisted(() => {
  const state = { mode: 'acquire' as 'acquire' | 'statement' };
  const fakeClient = {
    statements: [] as string[],
    released: 0,
    query: async (sql: unknown) => {
      const text = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
      fakeClient.statements.push(text.trim().split(/\s+/)[0] ?? '');
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    },
    release: () => {
      fakeClient.released++;
    },
  };
  return { state, fakeClient };
});

const pager = vi.fn(async (_message: string) => true);
const emit = vi.fn();

function failure(): Error {
  return state.mode === 'acquire'
    ? new Error('timeout exceeded when trying to connect')
    : Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
}

vi.mock('../config/db.js', () => ({
  pool: {
    query: vi.fn(async () => {
      throw failure();
    }),
    connect: vi.fn(async () => {
      if (state.mode === 'acquire') throw failure();
      return fakeClient;
    }),
  },
}));
vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
// The risk assessor and the moderation screen are down too (worst case): the
// keyword tier alone must carry a high turn.
vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: vi.fn(async () => {
          throw Object.assign(new Error('503 server_is_overloaded'), { status: 503 });
        }),
      },
    };
    moderations = {
      create: vi.fn(async () => {
        throw Object.assign(new Error('503 server_is_overloaded'), { status: 503 });
      }),
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
const { flagSessionCrisis } = await import('./crisisDetection.service.js');
const crisisPaging = await import('./crisisPaging.service.js');
const { toolRegistry } = await import('./toolRegistry.service.js');
const { clearCrisisResourceState } = await import('./crisisResources.js');
const { prepareTextHandoff, recordClientHandoffFallback } = await import('./textHandoff.service.js');

const waitForPage = async (times = 1): Promise<void> => {
  const deadline = Date.now() + 8000;
  while (pager.mock.calls.length < times) {
    if (Date.now() > deadline) throw new Error(`no page after 8 s (${pager.mock.calls.length} sent)`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const resourcesShown = (sessionId: string): boolean =>
  emit.mock.calls.some(
    ([event, payload]) =>
      event === 'session:crisis-emergency' && (payload as { sessionId?: string })?.sessionId === sessionId,
  );

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  pager.mockClear();
  emit.mockClear();
  fakeClient.statements = [];
  fakeClient.released = 0;
  crisisPaging._resetPagingStateForTests();
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = { to: vi.fn(() => ({ emit })) };
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  // Let fire-and-forget work finish inside the test that started it.
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

const modes: Mode[] = ['acquire', 'statement'];

describe.each(modes)('crisis path with every database call failing: %s timeout', (mode) => {
  beforeEach(() => {
    state.mode = mode;
  });

  it('voice turn: a high-risk disclosure shows the resources and pages the on-call', async () => {
    const sessionId = `voice_${mode}`;
    const result = await runCrisisPipeline(
      { sessionId, messageId: null, content: 'I am going to kill myself tonight' },
      'realtime',
    );
    expect(result.severity).toBe('high');
    await waitForPage();
    expect(resourcesShown(sessionId)).toBe(true);
  });

  it('chat turn: a high-risk disclosure pages, shows resources and returns the safety steer', async () => {
    const sessionId = `chat_${mode}`;
    const result = await runCrisisPipeline({ sessionId, messageId: null, content: 'I want to kill myself' }, 'chat');
    expect(result.severity).toBe('high');
    expect(result.steeringGuidance).toBeTruthy();
    await waitForPage();
    expect(resourcesShown(sessionId)).toBe(true);
  });

  it('escalate_to_human (high): the flag write fails, the page and the resources still go out', async () => {
    const sessionId = `esc_${mode}`;
    const result = (await toolRegistry.executeTool(
      'escalate_to_human',
      { reason: 'participant describes a plan', urgency: 'high' },
      { sessionId },
    )) as { success?: boolean };
    expect(result.success).toBe(true);
    await waitForPage();
    expect(resourcesShown(sessionId)).toBe(true);
  });

  it('flagSessionCrisis rejects with the timeout (callers fail toward paging) and never leaks the client', async () => {
    await expect(flagSessionCrisis(`flag_${mode}`, 'high', 90, 'system', 'auto', null, [], null)).rejects.toMatchObject(
      mode === 'acquire' ? { message: /timeout exceeded/ } : { code: '57014' },
    );
    if (mode === 'statement') {
      expect(fakeClient.statements).toEqual(['BEGIN', 'UPDATE', 'ROLLBACK']);
      expect(fakeClient.released).toBe(1);
    }
  });

  it('pageHighRisk pages when every paging lookup fails', async () => {
    const decision = await crisisPaging.pageHighRisk(`page_${mode}`, 90);
    expect(decision.outcome).toBe('paged');
    expect(pager).toHaveBeenCalledTimes(1);
  });

  it('a vendor cut with unreadable risk pages instead of waiting for the silence check', async () => {
    const decision = await crisisPaging.pageVendorTermination({
      sessionId: `cut_${mode}`,
      cause: 'content_filter',
      flagged: false,
      severity: null,
    });
    expect(decision.outcome).toBe('paged');
    expect(pager).toHaveBeenCalledTimes(1);
  });

  it('the silence check pages when it cannot tell whether the participant spoke', async () => {
    const decision = await crisisPaging.runVendorCutSilenceCheck(`silent_${mode}`, Date.now() - 180_000);
    expect(decision?.outcome).toBe('paged');
  });

  it('a stored silence check whose claim fails runs unclaimed and pages', async () => {
    const outcome = await crisisPaging.runStoredSilenceCheck(7, {
      sessionId: `stored_${mode}`,
      cutAt: Date.now() - 180_000,
    });
    expect(outcome).toBe('unclaimed');
    expect(pager).toHaveBeenCalledTimes(1);
  });

  it('the silence-check sweep returns cleanly and tries again next time (no throw, no crash)', async () => {
    await expect(crisisPaging.sweepSilenceChecks()).resolves.toEqual({ ran: 0, armed: 0, expired: 0 });
  });

  it('text hand-off: preparation rejects (the chat start catches it and the browser shows the crisis wording)', async () => {
    await expect(
      prepareTextHandoff({
        chatSessionId: `handoff_chat_${mode}`,
        continuedFrom: `handoff_voice_${mode}`,
        reason: 'content',
        canAccess: () => true,
        voiceEnabled: true,
      }),
    ).rejects.toBeTruthy();
  });

  it("text hand-off: the browser's fallback never throws", async () => {
    await expect(
      recordClientHandoffFallback({
        chatSessionId: `fb_chat_${mode}`,
        chatRow: {
          session_id: `fb_chat_${mode}`,
          user_id: 1,
          session_type: 'chat',
          status: 'active',
          crisis_flagged: false,
          crisis_severity: null,
        } as never,
        continuedFrom: `fb_voice_${mode}`,
        reason: 'content',
        canAccess: () => true,
        voiceEnabled: true,
      }),
    ).resolves.toBeNull();
  });
});
