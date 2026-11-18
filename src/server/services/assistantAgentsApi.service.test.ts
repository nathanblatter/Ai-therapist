// Agents API backend (features.assistant_agents_api_enabled): tool calls run
// through the shared authorization + audit path, only aggregate-only tools
// are exposed, small cells are suppressed, the session config forbids
// sandbox/hosted tools/MCP/subagents, and every session is deleted.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  AGENTS_API_SESSION_APP,
  agentsApiTools,
  foldHistory,
  minimiseForAgentsApi,
  setAgentsClientForTest,
  sweepOrphanedAgentSessions,
} from './assistantAgentsApi.service.js';

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

function fakeAgents(events: Ev[]) {
  const create = vi.fn().mockImplementation(() =>
    Promise.resolve({
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    }),
  );
  const del = vi.fn().mockResolvedValue({ deleted: true });
  const eventsCreate = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue({ data: [], has_more: false });
  const client = { beta: { agents: { sessions: { create, delete: del, list, events: { create: eventsCreate } } } } };
  setAgentsClientForTest(client as never);
  return { create, del, eventsCreate, list };
}

function submittedResults(eventsCreate: ReturnType<typeof vi.fn>): Ev[] {
  return eventsCreate.mock.calls.flatMap((c) => (c[1] as { events: Ev[] }).events);
}

beforeEach(() => {
  vi.clearAllMocks();
  poolMocks.pool.query.mockResolvedValue({ rows: [] });
  configMocks.getSystemConfig.mockResolvedValue({ features: { assistant_agents_api_enabled: true } });
});

describe('agents api backend', () => {
  it('creates a sandbox-free session with only aggregate-only tools and deletes it', async () => {
    const { create, del } = fakeAgents([created, done('Hello.'), completed]);
    const result = await runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ answer: 'Hello.', toolCalls: [] });

    const body = create.mock.calls[0][0] as {
      environment: unknown;
      stream: unknown;
      metadata: unknown;
      vault_ids?: unknown;
      agent: { model: string; multi_agent: unknown; tools: unknown };
    };
    expect(body.environment).toEqual({ type: 'none' });
    expect(body.stream).toBe(true);
    expect(body.metadata).toEqual({ app: AGENTS_API_SESSION_APP });
    expect(body.agent.model).toBe('gpt-5.2');
    expect(body.agent.multi_agent).toEqual({ enabled: false });
    expect(body.vault_ids).toBeUndefined();
    const tools = body.agent.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'programmatic_tool_calling', enabled: false });
    // No hosted tools of any kind: only our functions.
    expect(tools.slice(1).every((t) => t.type === 'function')).toBe(true);
    expect(tools.slice(1).map((t) => t.name)).toEqual(['study_overview']);
    expect(del).toHaveBeenCalledWith('sess_1');
  });

  it('exposes no data tools to roles whose tools all return per-participant rows', () => {
    expect(agentsApiTools('researcher').map((t) => t.name)).toEqual(['study_overview']);
    expect(agentsApiTools('therapist')).toEqual([]);
    expect(agentsApiTools('caseworker')).toEqual([]);
  });

  it('runs a tool call through the shared executor with the caller identity and audits it', async () => {
    surveyMocks.getSurveyDataOverview.mockResolvedValue({
      funnel: { invited: 40 },
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
    const result = await runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'enrollment?' }]);
    expect(result).toEqual({ answer: 'Enrollment is 40.', toolCalls: [{ name: 'study_overview', rowCount: 1 }] });
    expect(surveyMocks.getSurveyDataOverview).toHaveBeenCalledTimes(1);

    const [res] = submittedResults(eventsCreate);
    expect(res).toMatchObject({ type: 'agent.session.input.tool_result', call_id: 'c1', turn_id: 't1', success: true });
    // Participant rows never leave: the tool already projects to a count.
    expect(String(res.output)).not.toContain('p1');
    expect(JSON.parse(String(res.output)).participantCount).toBe(1);

    const auditArgs = poolMocks.pool.query.mock.calls.at(-1)![1] as unknown[];
    expect(auditArgs.slice(0, 4)).toEqual([
      1,
      'researcher',
      'enrollment?',
      JSON.stringify([{ name: 'study_overview', args: {}, row_count: 1 }]),
    ]);
    expect(auditArgs[4]).toBe(AGENTS_API_AUDIT_MODEL);
    expect(auditArgs.slice(5)).toEqual([100, 20]);
    expect(del).toHaveBeenCalledWith('sess_1');
  });

  it('refuses a tool outside the role allowlist without executing it, and audits the attempt', async () => {
    const { eventsCreate } = fakeAgents([
      created,
      requires(action('study_overview', {})),
      done('Not available.'),
      completed,
    ]);
    const result = await runAssistantTurn(CTX_CASEWORKER, [{ role: 'user', content: 'study stats?' }]);
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
    const result = await runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'who is p4?' }]);
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
    await expect(runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(
      /unexpected required action/,
    );
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('sess_1');
  });

  it('treats a failed turn as an error, deletes the session and writes no audit row when nothing ran', async () => {
    const { del } = fakeAgents([
      created,
      { type: 'agent.session.turn.failed', turn: { subagent_id: null, error: { message: 'overloaded' } } },
    ]);
    await expect(runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/overloaded/);
    expect(del).toHaveBeenCalledWith('sess_1');
    expect(poolMocks.pool.query).not.toHaveBeenCalled();
  });

  it('audits tools that ran even when the turn fails afterwards', async () => {
    surveyMocks.getSurveyDataOverview.mockResolvedValue({
      funnel: {},
      participants: [],
      weeklyAggregates: [],
      instrumentAggregates: [],
    });
    fakeAgents([created, requires(action('study_overview', '{}')), { type: 'error', error: { message: 'boom' } }]);
    await expect(runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(/boom/);
    const auditArgs = poolMocks.pool.query.mock.calls.at(-1)![1] as unknown[];
    expect(JSON.parse(auditArgs[3] as string)).toEqual([{ name: 'study_overview', args: {}, row_count: 1 }]);
  });

  it('errors when the stream ends before the turn completes', async () => {
    const { del } = fakeAgents([created, done('partial')]);
    await expect(runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'x' }])).rejects.toThrow(
      /before the turn completed/,
    );
    expect(del).toHaveBeenCalledWith('sess_1');
  });
});

describe('agents api data minimisation', () => {
  it('suppresses aggregates over fewer than five participants', () => {
    const out = minimiseForAgentsApi('study_overview', {
      funnel: { invited: 3 },
      participantCount: 3,
      weeklyAggregates: [
        { week: 1, n: 2, avgMood: 4.5, avgStress: 1, avgHelpfulness: 5 },
        { week: 2, n: 6, avgMood: 3, avgStress: 2, avgHelpfulness: 4 },
      ],
      instrumentAggregates: [{ role: 'baseline', n: 1, avgPhq2: 5, avgGad2: 4, phq2Positive: 1, gad2Positive: 1 }],
    }) as { weeklyAggregates: unknown[]; instrumentAggregates: unknown[] };
    expect(out.weeklyAggregates[0]).toMatchObject({
      week: 1,
      n: 2,
      avgMood: null,
      avgStress: null,
      avgHelpfulness: null,
    });
    expect(out.weeklyAggregates[1]).toMatchObject({ week: 2, n: 6, avgMood: 3 });
    expect(out.instrumentAggregates[0]).toMatchObject({ n: 1, avgPhq2: null, phq2Positive: null, gad2Positive: null });
  });

  it('folds earlier turns into one user message (the API takes user input only)', () => {
    expect(foldHistory([{ role: 'user', content: 'q' }])).toBe('q');
    const folded = foldHistory([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
    expect(folded).toContain('[staff] first');
    expect(folded).toContain('[assistant] answer');
    expect(folded.endsWith('Current question:\nsecond')).toBe(true);
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
    expect(del).toHaveBeenCalledWith('old_ours');
  });
});
