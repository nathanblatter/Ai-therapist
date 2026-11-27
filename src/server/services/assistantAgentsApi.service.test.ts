// Agents API backend (features.assistant_agents_api_enabled): tool calls run
// through the shared authorization + audit path, only aggregate-only tools
// are exposed, small counts are withheld, only the question being asked is
// sent, the session config forbids sandbox/hosted tools/MCP/subagents, every
// turn that sent anything is audited, and every session is deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getAllCrisisData: vi.fn(),
  listCaseworkerRoster: vi.fn(),
  getAllUsers: vi.fn(),
  listEscalations: vi.fn(),
  listWorkItemsForMember: vi.fn(),
  listWorkItemsForOrg: vi.fn(),
  isAssigned: vi.fn(),
}));
vi.mock('../db/index.js', () => dbMocks);

const poolMocks = vi.hoisted(() => ({ pool: { query: vi.fn() } }));
vi.mock('../config/db.js', () => poolMocks);

const surveyMocks = vi.hoisted(() => ({ getSurveyDataOverview: vi.fn() }));
vi.mock('./surveyData.service.js', () => surveyMocks);

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('sk-test') }));

const configMocks = vi.hoisted(() => ({ getSystemConfig: vi.fn() }));
vi.mock('../utils/sessionHelpers.js', () => configMocks);

import { runAssistantTurn, type AssistantContext } from './assistant.service.js';
import {
  AGENTS_API_AUDIT_MODEL,
  AGENTS_API_CONTROL_TIMEOUT_MS,
  AGENTS_API_SESSION_APP,
  AGENTS_API_SESSION_SPEND_LIMIT_CENTS,
  AGENTS_API_SPEND_CEILING_CODE,
  AGENTS_API_TURN_TIMEOUT_MS,
  agentsApiAfterTurnWork,
  agentsApiInput,
  agentsApiInstructions,
  agentsApiTools,
  minimiseForAgentsApi,
  setAgentsClientForTest,
  sweepOrphanedAgentSessions,
} from './assistantAgentsApi.service.js';

/** Options every call other than the turn stream is made with. */
const CONTROL = { timeout: AGENTS_API_CONTROL_TIMEOUT_MS, maxRetries: 0 };

const CTX_RESEARCHER: AssistantContext = { userId: 1, role: 'researcher', username: 'nathan', orgId: 5 };
const CTX_CASEWORKER: AssistantContext = { userId: 9, role: 'caseworker', username: 'cw', orgId: 5 };

type Ev = Record<string, unknown>;

function action(name: string, args: unknown, callId = 'c1') {
  return { type: 'function_call', name, arguments: args, call_id: callId, turn_id: 't1' };
}
const created: Ev = { type: 'agent.session.created', session: { id: 'sess_1', required_actions: [] } };
const requires = (...acts: Ev[]): Ev => ({
  type: 'agent.session.requires_action',
  session: { id: 'sess_1', required_actions: acts },
});
const done = (text: string): Ev => ({ type: 'agent.session.turn.output_text.done', session_id: 'sess_1', text });
const completed: Ev = {
  type: 'agent.session.turn.completed',
  session_id: 'sess_1',
  turn: { session_id: 'sess_1', subagent_id: null, usage: { input_tokens: 100, output_tokens: 20 } },
};

/** A stream that yields `events` and then, with `hang`, never ends. */
function streamOf(events: Ev[], hang = false) {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (hang) await new Promise(() => undefined);
    },
  };
}

function fakeAgents(events: Ev[], hang = false) {
  const create = vi.fn().mockImplementation(() => Promise.resolve(streamOf(events, hang)));
  const del = vi.fn().mockResolvedValue({ deleted: true });
  const eventsCreate = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue({ data: [], has_more: false });
  const retrieve = vi.fn().mockResolvedValue({ usage: null });
  const client = {
    beta: { agents: { sessions: { create, retrieve, delete: del, list, events: { create: eventsCreate } } } },
  };
  setAgentsClientForTest(client as never);
  return { create, del, eventsCreate, list, retrieve };
}

function submittedResults(eventsCreate: ReturnType<typeof vi.fn>): Ev[] {
  return eventsCreate.mock.calls.flatMap((c) => (c[1] as { events: Ev[] }).events);
}

/** Parameters of every assistant_audit INSERT so far. */
function auditInserts(): unknown[][] {
  return poolMocks.pool.query.mock.calls
    .filter((c) => /INSERT INTO assistant_audit/.test(String(c[0])))
    .map((c) => c[1] as unknown[]);
}
function auditInsert(): unknown[] {
  const rows = auditInserts();
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Run a turn, then wait for the work that follows the answer (deletion,
 *  late usage), which the turn itself no longer waits for. */
async function ask(ctx: AssistantContext, messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  try {
    return await runAssistantTurn(ctx, messages);
  } finally {
    await agentsApiAfterTurnWork();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  poolMocks.pool.query.mockResolvedValue({ rows: [{ audit_id: '77' }] });
  configMocks.getSystemConfig.mockResolvedValue({ features: { assistant_agents_api_enabled: true } });
});

afterEach(async () => {
  vi.useRealTimers();
  await agentsApiAfterTurnWork();
});

describe('agents api backend', () => {
  it('creates a sandbox-free session with only aggregate-only tools and deletes it', async () => {
    const { create, del } = fakeAgents([created, done('Hello.'), completed]);
    const result = await ask(CTX_RESEARCHER, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ answer: 'Hello.', toolCalls: [] });

    const body = create.mock.calls[0][0] as {
      environment: unknown;
      stream: unknown;
      metadata: unknown;
      input: unknown;
      vault_ids?: unknown;
      review: unknown;
      spend_control: unknown;
      agent: { model: string; multi_agent: unknown; tools: unknown };
    };
    expect(body.environment).toEqual({ type: 'none' });
    expect(body.stream).toBe(true);
    expect(body.metadata).toEqual({ app: AGENTS_API_SESSION_APP, turn: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(body.input).toBe('hi');
    // No SDK retry on create: a retried create could leave a second session behind.
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(body.agent.model).toBe('gpt-5.2');
    expect(body.agent.multi_agent).toEqual({ enabled: false });
    expect(body.vault_ids).toBeUndefined();
    expect(body.review).toBe('none');
    expect(body.spend_control).toEqual({ limit: AGENTS_API_SESSION_SPEND_LIMIT_CENTS });
    const tools = body.agent.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'programmatic_tool_calling', enabled: false });
    // No hosted tools of any kind: only our functions.
    expect(tools.slice(1).every((t) => t.type === 'function')).toBe(true);
    expect(tools.slice(1).map((t) => t.name)).toEqual(['study_overview']);
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
  });

  it('exposes no data tools to roles whose tools all return per-participant rows', () => {
    expect(agentsApiTools('researcher').map((t) => t.name)).toEqual(['study_overview']);
    expect(agentsApiTools('therapist')).toEqual([]);
    expect(agentsApiTools('caseworker')).toEqual([]);
  });

  it('runs a tool call through the shared executor with the caller identity and audits it', async () => {
    surveyMocks.getSurveyDataOverview.mockResolvedValue({
      funnel: { baselineFinished: 40, accountsCreated: 31, unlinkedFinished: 2 },
      participants: [{ userId: 1, username: 'p1' }],
      weeklyAggregates: [{ week: 1, n: 12, avgMood: 3.1, avgStress: 2, avgHelpfulness: 4 }],
      instrumentAggregates: [],
    });
    const { eventsCreate, del } = fakeAgents([
      created,
      requires(action('study_overview', {})),
      done('Enrollment is 40.'),
      completed,
    ]);
    const result = await ask(CTX_RESEARCHER, [{ role: 'user', content: 'enrollment?' }]);
    expect(result).toEqual({ answer: 'Enrollment is 40.', toolCalls: [{ name: 'study_overview', rowCount: 1 }] });
    expect(surveyMocks.getSurveyDataOverview).toHaveBeenCalledTimes(1);

    const [res] = submittedResults(eventsCreate);
    expect(res).toMatchObject({ type: 'agent.session.input.tool_result', call_id: 'c1', turn_id: 't1', success: true });
    // Participant rows never leave: the tool already projects to a count.
    expect(String(res.output)).not.toContain('p1');
    // One participant: the count itself is under five, so it is withheld.
    expect(JSON.parse(String(res.output)).participantCount).toBeNull();
    expect(JSON.parse(String(res.output)).funnel).toEqual({
      baselineFinished: 40,
      accountsCreated: 30,
      unlinkedFinished: null,
    });

    const auditArgs = auditInsert();
    expect(auditArgs.slice(0, 4)).toEqual([
      1,
      'researcher',
      'enrollment?',
      JSON.stringify([{ name: 'study_overview', args: {}, row_count: 1 }]),
    ]);
    expect(auditArgs[4]).toBe(AGENTS_API_AUDIT_MODEL);
    expect(auditArgs.slice(5)).toEqual([100, 20]);
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
  });

  it('refuses a tool outside the role allowlist without executing it, and audits the attempt', async () => {
    const { eventsCreate } = fakeAgents([
      created,
      requires(action('study_overview', {})),
      done('Not available.'),
      completed,
    ]);
    const result = await ask(CTX_CASEWORKER, [{ role: 'user', content: 'study stats?' }]);
    expect(surveyMocks.getSurveyDataOverview).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([{ name: 'study_overview', rowCount: 0 }]);
    const [res] = submittedResults(eventsCreate);
    expect(JSON.parse(String(res.output))).toEqual({
      error: 'Tool study_overview is not available to the caseworker role.',
    });
  });

  it('refuses a role-allowed per-participant tool on this backend without executing it', async () => {
    const { eventsCreate } = fakeAgents([
      created,
      requires(action('user_lookup', { username: 'p4' })),
      done('Not here.'),
      completed,
    ]);
    const result = await ask(CTX_RESEARCHER, [{ role: 'user', content: 'who is p4?' }]);
    expect(dbMocks.getAllUsers).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([{ name: 'user_lookup', rowCount: 0 }]);
    const [res] = submittedResults(eventsCreate);
    expect(JSON.parse(String(res.output))).toEqual({
      error: 'Tool user_lookup is not available on this assistant backend.',
    });
  });

  it('fails closed on an unexpected required action and still deletes the session', async () => {
    const { del, eventsCreate } = fakeAgents([
      created,
      requires({ type: 'mcp_approval_request', request_id: 'r1', turn_id: 't1' }),
    ]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/unexpected required action/);
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
  });

  it('treats a failed turn as an error, deletes the session and still audits the question that was stored', async () => {
    const { del } = fakeAgents([
      created,
      { type: 'agent.session.turn.failed', turn: { subagent_id: null, error: { message: 'overloaded' } } },
    ]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/overloaded/);
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
    // The session existed, so the question reached OpenAI's store: audited.
    const auditArgs = auditInsert();
    expect(auditArgs.slice(0, 5)).toEqual([1, 'researcher', 'x', '[]', AGENTS_API_AUDIT_MODEL]);
  });

  it('sends only the question being asked, whatever chat history the client supplies', async () => {
    // A caseworker's open chat holds an answer from the stateless backend
    // (crisis events with usernames). The flag flips; they ask one more thing.
    const history = [
      { role: 'user' as const, content: 'Any crisis events for my clients this week?' },
      { role: 'assistant' as const, content: 'Yes: p_alvarez (high, 14 Nov) and p_okafor (medium, 16 Nov).' },
      { role: 'user' as const, content: 'And how many sessions did p_alvarez have?' },
      { role: 'assistant' as const, content: 'p_alvarez had 6 sessions.' },
      { role: 'user' as const, content: 'How many participants are enrolled?' },
    ];
    expect(agentsApiInput(history)).toBe('How many participants are enrolled?');
    for (const ctx of [CTX_CASEWORKER, CTX_RESEARCHER]) {
      const { create } = fakeAgents([created, done('ok'), completed]);
      await ask(ctx, history);
      const body = create.mock.calls[0][0] as { input: unknown };
      expect(body.input).toBe('How many participants are enrolled?');
      expect(JSON.stringify(body)).not.toMatch(/alvarez|okafor|crisis events for my clients|6 sessions/);
      // The audit row records exactly what was sent.
      expect(auditInserts().at(-1)![2]).toBe('How many participants are enrolled?');
    }
    // The model is told a follow-up arrives without its context.
    expect(agentsApiInstructions(CTX_CASEWORKER)).toMatch(/cannot see earlier questions or answers/);
  });

  it('audits the turn and deletes nothing when the request to create the session fails', async () => {
    const { create, del, list } = fakeAgents([]);
    create.mockRejectedValueOnce(new Error('401 no agents scope'));
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/401/);
    // The request was sent, so the question may be at OpenAI: audited anyway.
    expect(auditInsert().slice(0, 5)).toEqual([1, 'researcher', 'x', '[]', AGENTS_API_AUDIT_MODEL]);
    expect(del).not.toHaveBeenCalled();
    // No session id, so the session is looked for by this turn's tag.
    const turnTag = (create.mock.calls[0][0] as { metadata: { turn: string } }).metadata.turn;
    expect(list).toHaveBeenCalledWith({ limit: 20, metadata: { app: AGENTS_API_SESSION_APP, turn: turnTag } }, CONTROL);
  });

  it('audits and cleans up when the connection is aborted before the first stream event', async () => {
    const { create, del, list } = fakeAgents([]);
    const aborted = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
    create.mockRejectedValueOnce(aborted);
    // The session was created at OpenAI even though this server never saw it.
    const turnTagOf = () => (create.mock.calls[0][0] as { metadata: { turn: string } }).metadata.turn;
    // All three are seconds old, so the age-guarded sweep that also runs after
    // a turn leaves them alone: only the lookup by turn tag may delete here.
    const now = Date.now() / 1000;
    list.mockImplementation((query: { metadata: { turn?: string } }) =>
      Promise.resolve({
        data: [
          { id: 'sess_unseen', created_at: now, metadata: { app: AGENTS_API_SESSION_APP, turn: turnTagOf() } },
          // Never deleted: another turn's session, and one that is not ours.
          { id: 'sess_other_turn', created_at: now, metadata: { app: AGENTS_API_SESSION_APP, turn: 'someone-else' } },
          {
            id: 'sess_not_ours',
            created_at: now,
            metadata: { app: 'something-else', turn: query.metadata.turn ?? '' },
          },
        ],
        has_more: false,
      }),
    );
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'who is p4?' }])).rejects.toThrow(/aborted/);
    expect(auditInsert().slice(0, 5)).toEqual([1, 'researcher', 'who is p4?', '[]', AGENTS_API_AUDIT_MODEL]);
    expect(del.mock.calls.map((c) => c[0])).toEqual(['sess_unseen']);
  });

  it('audits and looks for the session by its tag when the stream ends without naming one', async () => {
    const { create, del, list } = fakeAgents([]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/before the turn completed/);
    expect(auditInsert().slice(0, 5)).toEqual([1, 'researcher', 'x', '[]', AGENTS_API_AUDIT_MODEL]);
    expect(del).not.toHaveBeenCalled();
    const turnTag = (create.mock.calls[0][0] as { metadata: { turn: string } }).metadata.turn;
    expect(list.mock.calls[0][0]).toEqual({ limit: 20, metadata: { app: AGENTS_API_SESSION_APP, turn: turnTag } });
  });

  it('keeps the whole turn safely under 60 s: one deadline, and nothing after it is waited for', () => {
    expect(AGENTS_API_TURN_TIMEOUT_MS).toBeLessThanOrEqual(45_000);
  });

  it('times out when no stream event ever arrives, audits, and rechecks for the session by tag', async () => {
    vi.useFakeTimers();
    const { create, del, list } = fakeAgents([], true);
    const turn = runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'slow?' }]);
    const failed = expect(turn).rejects.toMatchObject({ name: 'AgentsApiTurnError', code: 'timeout' });
    await vi.advanceTimersByTimeAsync(AGENTS_API_TURN_TIMEOUT_MS - 1);
    expect(auditInserts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    await agentsApiAfterTurnWork();
    expect(auditInsert().slice(0, 5)).toEqual([1, 'researcher', 'slow?', '[]', AGENTS_API_AUDIT_MODEL]);
    expect(del).not.toHaveBeenCalled();
    // The turn's own abort signal was handed to the SDK and has fired.
    expect((create.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    const tagged = () => list.mock.calls.filter((c) => (c[0] as { metadata: { turn?: string } }).metadata.turn);
    expect(tagged()).toHaveLength(1);
    // The session shows up in filtered results late: the recheck finds it.
    const turnTag = (create.mock.calls[0][0] as { metadata: { turn: string } }).metadata.turn;
    list.mockResolvedValue({
      data: [{ id: 'sess_late', created_at: 1, metadata: { app: AGENTS_API_SESSION_APP, turn: turnTag } }],
      has_more: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await agentsApiAfterTurnWork();
    expect(tagged()).toHaveLength(2);
    expect(del).toHaveBeenCalledWith('sess_late', CONTROL);
  });

  it('times out when the create call itself never returns', async () => {
    vi.useFakeTimers();
    const { create, del } = fakeAgents([]);
    const lateStream = streamOf([]);
    let arrive: (s: unknown) => void = () => undefined;
    create.mockImplementationOnce(() => new Promise((resolve) => (arrive = resolve)));
    const turn = runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }]);
    const failed = expect(turn).rejects.toThrow(/timed out after 40 s/);
    await vi.advanceTimersByTimeAsync(AGENTS_API_TURN_TIMEOUT_MS);
    await failed;
    await agentsApiAfterTurnWork();
    expect(auditInsert()[2]).toBe('x');
    expect(del).not.toHaveBeenCalled();
    // A stream that turns up after the deadline is closed, not left open.
    arrive(lateStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateStream.controller.signal.aborted).toBe(true);
  });

  it('times out mid-turn, deletes the session it knows about and audits the tools that ran', async () => {
    vi.useFakeTimers();
    surveyMocks.getSurveyDataOverview.mockResolvedValue({
      funnel: {},
      participants: [],
      weeklyAggregates: [],
      instrumentAggregates: [],
    });
    const { del, list } = fakeAgents([created, requires(action('study_overview', {}))], true);
    const turn = runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }]);
    const failed = expect(turn).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(AGENTS_API_TURN_TIMEOUT_MS);
    await failed;
    await agentsApiAfterTurnWork();
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
    expect(JSON.parse(auditInsert()[3] as string)).toEqual([{ name: 'study_overview', args: {}, row_count: 1 }]);
    // The id was known, so no lookup by turn tag was needed.
    expect(list.mock.calls.filter((c) => (c[0] as { metadata: { turn?: string } }).metadata.turn)).toHaveLength(0);
  });

  it('times out while a tool is still running, without waiting for it', async () => {
    vi.useFakeTimers();
    surveyMocks.getSurveyDataOverview.mockReturnValue(new Promise(() => undefined));
    const { del, eventsCreate } = fakeAgents([created, requires(action('study_overview', {})), done('x'), completed]);
    const turn = runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }]);
    const failed = expect(turn).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(AGENTS_API_TURN_TIMEOUT_MS);
    await failed;
    await agentsApiAfterTurnWork();
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
    expect(auditInserts()).toHaveLength(1);
  });

  it('cancels and retries when a session refuses deletion mid-turn', async () => {
    const { del, eventsCreate } = fakeAgents([created, { type: 'error', error: { message: 'boom' } }]);
    del.mockRejectedValueOnce(new Error('409 turn in progress'));
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/boom/);
    expect(eventsCreate).toHaveBeenCalledWith('sess_1', { events: [{ type: 'agent.session.input.cancel' }] }, CONTROL);
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('stops before the model runs when the created session reports a tool we did not ask for', async () => {
    const withTools = (tools: Ev[]): Ev => ({
      type: 'agent.session.created',
      session: { id: 'sess_1', required_actions: [], agent: { tools } },
    });
    const ours = [
      { type: 'programmatic_tool_calling', enabled: false },
      { type: 'function', name: 'study_overview', defer_loading: false, async: false },
    ];
    // The echo of exactly what we sent (shape observed live) is accepted.
    fakeAgents([withTools(ours), done('ok'), completed]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).resolves.toMatchObject({
      answer: 'ok',
    });

    for (const extra of [
      { type: 'web_search' },
      { type: 'programmatic_tool_calling', enabled: true },
      { type: 'mcp', server_label: 's' },
      { type: 'function', name: 'user_lookup' },
    ]) {
      const { del, eventsCreate } = fakeAgents([
        withTools([...ours.slice(1), extra]),
        requires(action('study_overview', {})),
        done('never'),
        completed,
      ]);
      await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/unexpected tools/);
      expect(surveyMocks.getSurveyDataOverview).not.toHaveBeenCalled();
      expect(eventsCreate).not.toHaveBeenCalled();
      expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
    }
  });

  it('fails the turn when the session reaches its spend ceiling (the shapes the API really sends)', async () => {
    // openai 7.57.0: the ceiling is a failed turn whose error code is
    // session_budget_exceeded (SessionTurnError); the stream `error` event
    // carries the same code. The session-budget guide also names an
    // agent.session.budget_reached event the SDK does not type.
    const shapes: Ev[] = [
      {
        type: 'agent.session.turn.failed',
        session_id: 'sess_1',
        turn_id: 't1',
        usage: null,
        turn: {
          session_id: 'sess_1',
          subagent_id: null,
          status: 'failed',
          error: { code: 'session_budget_exceeded', message: 'The session has reached its usage budget.' },
        },
      },
      {
        type: 'error',
        session_id: 'sess_1',
        error: { code: 'session_budget_exceeded', message: 'budget', param: null, type: 'invalid_request_error' },
      },
      { type: 'agent.session.budget_reached', session_id: 'sess_1' },
    ];
    for (const shape of shapes) {
      const { del } = fakeAgents([created, shape, done('never'), completed]);
      await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
        name: 'AgentsApiTurnError',
        code: AGENTS_API_SPEND_CEILING_CODE,
        message: expect.stringMatching(/spend ceiling of 25 cents/),
      });
      expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
    }
    expect(auditInserts()).toHaveLength(shapes.length);
  });

  it('does not mistake another failure, or a failing subagent turn, for the spend ceiling', async () => {
    fakeAgents([
      created,
      { type: 'agent.session.turn.failed', turn: { subagent_id: null, error: { code: 'server_overloaded' } } },
    ]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'server_overloaded',
    });
    fakeAgents([
      created,
      { type: 'agent.session.turn.failed', turn: { subagent_id: 'sub_1', error: { code: 'session_budget_exceeded' } } },
      done('Fine.'),
      completed,
    ]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).resolves.toMatchObject({ answer: 'Fine.' });
  });

  it('answers a tool request beyond the per-question budget with a failure instead of running it', async () => {
    surveyMocks.getSurveyDataOverview.mockResolvedValue({
      funnel: {},
      participants: [],
      weeklyAggregates: [],
      instrumentAggregates: [],
    });
    const many = Array.from({ length: 13 }, (_, i) => action('study_overview', {}, `c${i}`));
    const { eventsCreate } = fakeAgents([created, requires(...many), done('Done.'), completed]);
    const result = await ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }]);
    expect(surveyMocks.getSurveyDataOverview).toHaveBeenCalledTimes(12);
    expect(result.toolCalls).toHaveLength(12);
    expect(submittedResults(eventsCreate).at(-1)).toMatchObject({ call_id: 'c12', success: false });
  });

  it('audits tools that ran even when the turn fails afterwards', async () => {
    surveyMocks.getSurveyDataOverview.mockResolvedValue({
      funnel: {},
      participants: [],
      weeklyAggregates: [],
      instrumentAggregates: [],
    });
    fakeAgents([created, requires(action('study_overview', '{}')), { type: 'error', error: { message: 'boom' } }]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/boom/);
    const auditArgs = auditInsert();
    expect(JSON.parse(auditArgs[3] as string)).toEqual([{ name: 'study_overview', args: {}, row_count: 1 }]);
  });

  it('returns the answer before looking up late usage or deleting the session', async () => {
    // Usage is null on turn.completed (observed live) and appears on the
    // session about two seconds later. Neither that wait nor the delete may
    // hold the answer back: here both calls never return at all.
    const lateCompleted: Ev = { ...completed, turn: { session_id: 'sess_1', subagent_id: null, usage: null } };
    const { retrieve, del } = fakeAgents([created, done('Hi.'), lateCompleted]);
    let release: (v: unknown) => void = () => undefined;
    retrieve.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const result = await runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ answer: 'Hi.', toolCalls: [] });
    // The audit row is already written (with the counts known so far)...
    expect(auditInsert().slice(5)).toEqual([0, 0]);
    // ...and the session is still there, because usage has not been read yet.
    expect(del).not.toHaveBeenCalled();
    release({ usage: null });
    retrieve.mockResolvedValue({ usage: { input_tokens: 9990, output_tokens: 42 } });
    await agentsApiAfterTurnWork();
    // The late figures are added to the same audit row, then the session goes.
    const update = poolMocks.pool.query.mock.calls.find((c) => /UPDATE assistant_audit/.test(String(c[0])))!;
    expect(update[1]).toEqual([9990, 42, 77]);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve.mock.invocationCallOrder.at(-1)!).toBeLessThan(del.mock.invocationCallOrder[0]);
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
  });

  it('does not look usage up when turn.completed already carried it', async () => {
    const { retrieve, del } = fakeAgents([created, done('Hi.'), completed]);
    await ask(CTX_RESEARCHER, [{ role: 'user', content: 'hi' }]);
    expect(retrieve).not.toHaveBeenCalled();
    expect(auditInsert().slice(5)).toEqual([100, 20]);
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
  });

  it('errors when the stream ends before the turn completes', async () => {
    const { del } = fakeAgents([created, done('partial')]);
    await expect(ask(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/before the turn completed/);
    expect(del).toHaveBeenCalledWith('sess_1', CONTROL);
  });
});

describe('agents api data minimisation', () => {
  type Overview = {
    countRule: string;
    funnel: Record<string, number | null>;
    participantCount: number | null;
    weeklyAggregates: Array<Record<string, unknown>>;
    instrumentAggregates: Array<Record<string, unknown>>;
  };

  it('withholds every figure, and the n itself, for a cell of fewer than five participants', () => {
    const out = minimiseForAgentsApi('study_overview', {
      funnel: { baselineFinished: 3, accountsCreated: 3, unlinkedFinished: 0 },
      participantCount: 3,
      weeklyAggregates: [
        { week: 1, n: 2, avgMood: 4.5, avgStress: 1, avgHelpfulness: 5 },
        { week: 2, n: 6, avgMood: 3, avgStress: 2, avgHelpfulness: 4 },
      ],
      instrumentAggregates: [{ role: 'baseline', n: 1, avgPhq2: 5, avgGad2: 4, phq2Positive: 1, gad2Positive: 1 }],
    }) as Overview;
    expect(out.funnel).toEqual({ baselineFinished: null, accountsCreated: null, unlinkedFinished: null });
    expect(out.participantCount).toBeNull();
    expect(out.weeklyAggregates[0]).toEqual({
      week: 1,
      n: null,
      avgMood: null,
      avgStress: null,
      avgHelpfulness: null,
      suppressed: 'fewer than 5 participants',
    });
    expect(out.weeklyAggregates[1]).toEqual({ week: 2, n: 5, avgMood: 3, avgStress: 2, avgHelpfulness: 4 });
    expect(out.instrumentAggregates[0]).toMatchObject({
      n: null,
      avgPhq2: null,
      avgGad2: null,
      phq2Positive: null,
      gad2Positive: null,
    });
    expect(out.countRule).toMatch(/rounded to the nearest 5/);
  });

  it('never publishes a count that discloses every member of a group (five of five positive)', () => {
    const out = minimiseForAgentsApi('study_overview', {
      funnel: { baselineFinished: 5, accountsCreated: 5, unlinkedFinished: 0 },
      participantCount: 5,
      weeklyAggregates: [],
      instrumentAggregates: [
        // Everyone positive, everyone negative, all but two, and a mid-range cell.
        { role: 'baseline', n: 5, avgPhq2: 4.2, avgGad2: 0.4, phq2Positive: 5, gad2Positive: 0 },
        { role: 'exit', n: 30, avgPhq2: 3, avgGad2: 2, phq2Positive: 28, gad2Positive: 12 },
      ],
    }) as Overview;
    expect(out.instrumentAggregates[0]).toMatchObject({ n: 5, phq2Positive: null, gad2Positive: null });
    // 28 of 30 would say two people screened negative; 12 of 30 is published, rounded.
    expect(out.instrumentAggregates[1]).toMatchObject({ n: 30, phq2Positive: null, gad2Positive: 10 });
  });

  it('rounds every published count to the nearest 5, so a withheld one cannot be derived by subtraction', () => {
    const out = minimiseForAgentsApi('study_overview', {
      // 33 finished the baseline and 31 made an account: the difference (2
      // people) is the withheld unlinkedFinished unless both are rounded.
      funnel: { baselineFinished: 33, accountsCreated: 31, unlinkedFinished: 2 },
      participantCount: 31,
      weeklyAggregates: [
        { week: 1, n: 12, avgMood: 3.1, avgStress: 2, avgHelpfulness: 4 },
        { week: 2, n: 11, avgMood: 3.3, avgStress: 2, avgHelpfulness: 4 },
        { week: 3, n: 7, avgMood: 3.3, avgStress: 2, avgHelpfulness: 4 },
      ],
      instrumentAggregates: [],
    }) as Overview;
    expect(out.funnel).toEqual({ baselineFinished: 35, accountsCreated: 30, unlinkedFinished: null });
    expect(out.participantCount).toBe(30);
    expect(out.weeklyAggregates.map((c) => c.n)).toEqual([10, 10, 5]);
    // No published count is anything but a multiple of 5.
    const counts = [...Object.values(out.funnel), out.participantCount, ...out.weeklyAggregates.map((c) => c.n)];
    for (const c of counts) expect(c === null || (c as number) % 5 === 0).toBe(true);
  });

  it('rebuilds the result from named numeric fields: nothing else can ride along', () => {
    const out = minimiseForAgentsApi('study_overview', {
      funnel: { baselineFinished: 40, accountsCreated: 31, unlinkedFinished: 2, note: 'p7 dropped out' },
      participantCount: 31,
      // Fields a later change might add, and strings where numbers belong.
      participants: [{ userId: 7, username: 'p7' }],
      freeText: 'I feel hopeless',
      weeklyAggregates: [
        { week: 1, n: 9, avgMood: 3.2, avgStress: 'p7 said 5', avgHelpfulness: 4, usernames: ['p7'], comment: 'x' },
        { week: 2, avgMood: 1 },
        'p7',
      ],
      instrumentAggregates: [
        { role: 'baseline', n: 12, avgPhq2: 2.1, avgGad2: 1.9, phq2Positive: 6, gad2Positive: 'p7', lowest: 'p7' },
        { role: 'p7', n: 12, avgPhq2: 6 },
      ],
    });
    expect(out).toEqual({
      countRule: expect.any(String),
      funnel: { baselineFinished: 40, accountsCreated: 30, unlinkedFinished: null },
      participantCount: 30,
      weeklyAggregates: [{ week: 1, n: 10, avgMood: 3.2, avgStress: null, avgHelpfulness: 4 }],
      instrumentAggregates: [
        { role: 'baseline', n: 10, avgPhq2: 2.1, avgGad2: 1.9, phq2Positive: 5, gad2Positive: null },
      ],
    });
    expect(JSON.stringify(out)).not.toMatch(/p7|hopeless/);
  });

  it('lets a tool outside the eligible set return only a refusal, whatever it was handed', () => {
    const rows = [{ userid: 4, username: 'p4', role: 'participant' }];
    for (const name of ['user_lookup', 'session_stats', 'survey_completion', 'caseload_roster', 'made_up']) {
      expect(minimiseForAgentsApi(name, rows)).toEqual({
        error: `Tool ${name} is not available on this assistant backend.`,
      });
    }
    expect(minimiseForAgentsApi('study_overview', { error: 'This lookup failed', rows })).toEqual({
      error: 'This lookup failed',
    });
    expect(minimiseForAgentsApi('study_overview', null)).toMatchObject({ participantCount: null });
  });
});

describe('orphaned session sweep', () => {
  it('deletes only this app’s sessions older than five minutes', async () => {
    const { list, del } = fakeAgents([]);
    const now = 1_800_000_000_000;
    list.mockResolvedValue({
      data: [
        { id: 'old_ours', created_at: (now - 10 * 60_000) / 1000, metadata: { app: AGENTS_API_SESSION_APP } },
        { id: 'new_ours', created_at: (now - 60_000) / 1000, metadata: { app: AGENTS_API_SESSION_APP } },
        { id: 'old_other', created_at: (now - 10 * 60_000) / 1000, metadata: { app: 'something-else' } },
      ],
      has_more: false,
    });
    expect(await sweepOrphanedAgentSessions(now)).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('old_ours', CONTROL);
    // Filtered at OpenAI on our tag as well as checked row by row here.
    expect(list.mock.calls[0][0]).toMatchObject({ metadata: { app: AGENTS_API_SESSION_APP } });
  });

  it('pages with the last row id (the SDK page object has no last_id)', async () => {
    const { list, del } = fakeAgents([]);
    const now = 1_800_000_000_000;
    const old = (id: string) => ({
      id,
      created_at: (now - 10 * 60_000) / 1000,
      metadata: { app: AGENTS_API_SESSION_APP },
    });
    list
      .mockResolvedValueOnce({ data: [old('a'), old('b')], has_more: true })
      .mockResolvedValueOnce({ data: [old('c')], has_more: false });
    expect(await sweepOrphanedAgentSessions(now)).toBe(3);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({ after: 'b' });
    expect(del).toHaveBeenCalledTimes(3);
  });
});
