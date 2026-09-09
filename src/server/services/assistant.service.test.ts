// Assistant service: role matrix enforcement, caller-identity injection into
// tool scoping, output projection (no free-text columns), audit rows, and the
// tool loop against a mocked Responses client.
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

import { runAssistantTurn, setAssistantClientForTest, type AssistantContext } from './assistant.service.js';

const CTX_RESEARCHER: AssistantContext = { userId: 1, role: 'researcher', username: 'nathan', orgId: 5 };
const CTX_CASEWORKER: AssistantContext = { userId: 9, role: 'caseworker', username: 'cw', orgId: 5 };

function fakeClient(script: Array<{ output_text?: string; output?: unknown[] }>) {
  let i = 0;
  const create = vi.fn().mockImplementation(() => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return Promise.resolve({ output_text: step.output_text ?? '', output: step.output ?? [], usage: { input_tokens: 10, output_tokens: 5 } });
  });
  return { client: { responses: { create } }, create };
}

beforeEach(() => {
  vi.clearAllMocks();
  poolMocks.pool.query.mockResolvedValue({ rows: [] });
});

describe('runAssistantTurn', () => {
  it('returns plain text when the model calls no tools', async () => {
    const { client } = fakeClient([{ output_text: 'Hello.' }]);
    setAssistantClientForTest(client as never);
    const result = await runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'hi' }]);
    expect(result.answer).toBe('Hello.');
    expect(result.toolCalls).toEqual([]);
    // audit row still written
    expect(poolMocks.pool.query).toHaveBeenCalledWith(expect.stringContaining('assistant_audit'), expect.any(Array));
  });

  it('executes a tool with the caller identity injected and returns projected rows to the model', async () => {
    dbMocks.listSessions.mockResolvedValue([
      { session_id: 's1', username: 'p42', status: 'ended', secret_notes: 'MUST NOT LEAK', start_time: 't' },
    ]);
    const { client, create } = fakeClient([
      { output: [{ type: 'function_call', name: 'session_stats', call_id: 'c1', arguments: '{}' }] },
      { output_text: 'One session.' },
    ]);
    setAssistantClientForTest(client as never);

    const result = await runAssistantTurn(CTX_CASEWORKER, [{ role: 'user', content: 'sessions?' }]);
    expect(result.answer).toBe('One session.');
    expect(result.toolCalls).toEqual([{ name: 'session_stats', rowCount: 1 }]);
    // caseworker => caseload scope (their own userId) + org
    expect(dbMocks.listSessions).toHaveBeenCalledWith(expect.any(Object), 9, 5);
    // the tool output fed back to the model is whitelist-projected
    const secondCall = create.mock.calls[1][0] as { input: Array<Record<string, unknown>> };
    const toolOutput = secondCall.input.find((i) => i.type === 'function_call_output') as { output: string };
    expect(toolOutput.output).toContain('s1');
    expect(toolOutput.output).not.toContain('MUST NOT LEAK');
  });

  it('refuses tools outside the role matrix without executing anything', async () => {
    const { client } = fakeClient([
      { output: [{ type: 'function_call', name: 'study_overview', call_id: 'c1', arguments: '{}' }] },
      { output_text: 'Not available.' },
    ]);
    setAssistantClientForTest(client as never);
    const result = await runAssistantTurn(CTX_CASEWORKER, [{ role: 'user', content: 'study stats?' }]);
    expect(surveyMocks.getSurveyDataOverview).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([{ name: 'study_overview', rowCount: 0 }]);
  });

  it('scopes user_lookup to the caseload for care-team callers', async () => {
    dbMocks.getAllUsers.mockResolvedValue([
      { userid: 42, username: 'p42', role: 'participant', study_status: 'active', created_at: 't' },
      { userid: 43, username: 'p43', role: 'participant', study_status: 'active', created_at: 't' },
    ]);
    dbMocks.isAssigned.mockImplementation((_m: number, c: number) => Promise.resolve(c === 42));
    const { client, create } = fakeClient([
      { output: [{ type: 'function_call', name: 'user_lookup', call_id: 'c1', arguments: '{"username":"p4"}' }] },
      { output_text: 'Found p42.' },
    ]);
    setAssistantClientForTest(client as never);
    await runAssistantTurn(CTX_CASEWORKER, [{ role: 'user', content: 'who is p4?' }]);
    const secondCall = create.mock.calls[1][0] as { input: Array<Record<string, unknown>> };
    const toolOutput = secondCall.input.find((i) => i.type === 'function_call_output') as { output: string };
    expect(toolOutput.output).toContain('p42');
    expect(toolOutput.output).not.toContain('p43');
  });

  it('records the audit row with tools and usage', async () => {
    dbMocks.listWorkItemsForOrg.mockResolvedValue([]);
    const { client } = fakeClient([
      { output: [{ type: 'function_call', name: 'work_queue', call_id: 'c1', arguments: '{}' }] },
      { output_text: 'Queue empty.' },
    ]);
    setAssistantClientForTest(client as never);
    await runAssistantTurn(CTX_RESEARCHER, [{ role: 'user', content: 'queue?' }]);
    const auditArgs = poolMocks.pool.query.mock.calls.at(-1)![1] as unknown[];
    expect(auditArgs[0]).toBe(1); // user_id
    expect(auditArgs[1]).toBe('researcher');
    expect(auditArgs[2]).toBe('queue?');
    expect(JSON.parse(auditArgs[3] as string)).toEqual([{ name: 'work_queue', args: {}, row_count: 0 }]);
  });
});
