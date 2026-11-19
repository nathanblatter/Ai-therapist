import { describe, it, expect, beforeEach, vi } from 'vitest';

// The narrow crisis turn (ai-therapist-356, step 1b): the first participant
// turn after a crisis text hand-off is answered in ONE model call with tools
// withheld, and the tool calls the protocol requires are made straight
// afterwards, off the participant's clock.
const { createMock, getEnabledToolDefinitionsMock, executeLoggedToolCallMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getEnabledToolDefinitionsMock: vi.fn(),
  executeLoggedToolCallMock: vi.fn(),
}));

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    responses = { create: createMock };
  },
}));
vi.mock('./toolRegistry.service.js', () => ({
  toolRegistry: { getEnabledToolDefinitions: getEnabledToolDefinitionsMock },
}));
vi.mock('./toolExecution.helpers.js', () => ({ executeLoggedToolCall: executeLoggedToolCallMock }));
vi.mock('../utils/chatModel.js', () => ({ resolveChatModel: vi.fn().mockResolvedValue('gpt-test') }));
vi.mock('../utils/safetyIdentifier.js', () => ({ safetyIdentifierForSession: async () => 'sid-hash' }));
vi.mock('../db/index.js', () => ({
  recordLlmUsage: vi.fn().mockResolvedValue(undefined),
  insertTurnLatency: vi.fn().mockResolvedValue(undefined),
  getSessionAccessInfo: vi.fn(),
  getSessionConfig: vi.fn(),
  getSessionMessages: vi.fn(),
}));

const {
  initializeChatSession,
  seedAssistantOpening,
  sendMessage,
  getConversationHistory,
  endChatSession,
  NARROW_TURN_DOCUMENTATION_PROMPT,
  _narrowTurnDocumentationSettled,
} = await import('./chatTherapy.service.js');

const def = (name: string) => ({ type: 'function', name, description: name, parameters: { type: 'object' } });
const TOOLS = [def('show_resource_card'), def('run_risk_check'), def('escalate_to_human'), def('log_mood')];

type Call = { tools?: Array<{ name: string }>; tool_choice?: string; input: Array<Record<string, unknown>> };
const call = (i: number) => createMock.mock.calls[i][0] as Call;

function start(sid: string) {
  initializeChatSession(sid, 'SYSTEM PROMPT', 'gpt-test');
  seedAssistantOpening(sid, 'Are you thinking about ending your life tonight?');
}

beforeEach(() => {
  vi.clearAllMocks();
  getEnabledToolDefinitionsMock.mockResolvedValue(TOOLS);
  executeLoggedToolCallMock.mockResolvedValue({ result: { logged: true } });
});

describe('sendMessage with narrowCrisisTurn', () => {
  it('writes the reply in one model call with tools withheld', async () => {
    const sid = 'chat_narrow_1';
    start(sid);
    createMock
      .mockResolvedValueOnce({ output_text: 'Thank you for telling me. Have you thought about how?', output: [] })
      .mockResolvedValueOnce({ output_text: '', output: [] });

    const result = await sendMessage(sid, 'Yes', { narrowCrisisTurn: true });

    expect(result).toEqual({ text: 'Thank you for telling me. Have you thought about how?', toolEvents: [] });
    // The reply came from the FIRST call, and that call could not use a tool.
    expect(call(0).tool_choice).toBe('none');
    expect(call(0).input.at(-1)).toEqual({ role: 'user', content: 'Yes' });
    expect(executeLoggedToolCallMock).not.toHaveBeenCalled();
    await _narrowTurnDocumentationSettled(sid);
    endChatSession(sid);
  });

  // PR #77 review, item 7: output moderation is not skipped on the fast turn.
  it('the narrow reply is written with inline moderation on, and an elevated output score is surfaced', async () => {
    const sid = 'chat_narrow_mod';
    start(sid);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createMock
      .mockResolvedValueOnce({
        output_text: 'Thank you for telling me.',
        output: [],
        moderation: { output: { type: 'result', flagged: false, category_scores: { 'self-harm': 0.62 } } },
      })
      .mockResolvedValueOnce({ output_text: '', output: [] });
    await sendMessage(sid, 'Yes', { narrowCrisisTurn: true });
    expect((createMock.mock.calls[0][0] as { moderation?: unknown }).moderation).toEqual({
      model: 'omni-moderation-latest',
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('output moderation elevated'))).toBe(true);
    warn.mockRestore();
    await _narrowTurnDocumentationSettled(sid);
    endChatSession(sid);
  });

  it('then requires the safety-check and escalation tools in a second call, and runs what the model calls', async () => {
    const sid = 'chat_narrow_2';
    start(sid);
    createMock.mockResolvedValueOnce({ output_text: 'I am glad you told me.', output: [] }).mockResolvedValueOnce({
      output_text: '',
      output: [
        { type: 'reasoning', id: 'rs_1' },
        {
          type: 'function_call',
          name: 'run_risk_check',
          call_id: 'c1',
          arguments: '{"step":"ideation","answer":"Yes","risk_band":"high"}',
        },
        { type: 'function_call', name: 'escalate_to_human', call_id: 'c2', arguments: '{"urgency":"high"}' },
        { type: 'message', content: 'stray text the participant must never see' },
      ],
    });

    await sendMessage(sid, 'Yes', { narrowCrisisTurn: true });
    await _narrowTurnDocumentationSettled(sid);

    expect(createMock).toHaveBeenCalledTimes(2);
    const doc = call(1);
    expect(doc.tool_choice).toBe('required');
    expect(doc.tools?.map((t) => t.name).sort()).toEqual(['escalate_to_human', 'run_risk_check']);
    // It sees the turn that was just answered, then the documentation instruction.
    expect(doc.input.at(-1)).toEqual({ role: 'system', content: NARROW_TURN_DOCUMENTATION_PROMPT });
    expect(doc.input.at(-2)).toEqual({ role: 'assistant', content: 'I am glad you told me.' });
    expect(doc.input.at(-3)).toEqual({ role: 'user', content: 'Yes' });

    expect(executeLoggedToolCallMock).toHaveBeenCalledWith(
      sid,
      'run_risk_check',
      { step: 'ideation', answer: 'Yes', risk_band: 'high' },
      'c1',
      'chat',
    );
    expect(executeLoggedToolCallMock).toHaveBeenCalledWith(sid, 'escalate_to_human', { urgency: 'high' }, 'c2', 'chat');

    // The calls and their outputs are in the history for the next turn; the
    // instruction and any stray text are not.
    const history = getConversationHistory(sid) as Array<Record<string, unknown>>;
    const types = history.map((h) => h['type'] ?? h['role']);
    expect(types.slice(-6)).toEqual([
      'assistant',
      'reasoning',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
    ]);
    expect(JSON.stringify(history)).not.toContain('stray text');
    expect(JSON.stringify(history)).not.toContain('Documentation step');
    endChatSession(sid);
  });

  it('the next turn waits for the documentation and builds on a history that includes it', async () => {
    const sid = 'chat_narrow_3';
    start(sid);
    let releaseDoc: (value: unknown) => void = () => undefined;
    createMock
      .mockResolvedValueOnce({ output_text: 'first reply', output: [] })
      .mockImplementationOnce(() => new Promise((resolve) => (releaseDoc = resolve)))
      .mockResolvedValueOnce({ output_text: 'second reply', output: [] });

    await sendMessage(sid, 'Yes', { narrowCrisisTurn: true });
    const next = sendMessage(sid, 'I have pills');
    await new Promise((r) => setTimeout(r, 20));
    // The second turn has not called the model yet: it is waiting.
    expect(createMock).toHaveBeenCalledTimes(2);
    releaseDoc({
      output_text: '',
      output: [{ type: 'function_call', name: 'run_risk_check', call_id: 'c9', arguments: '{}' }],
    });
    expect((await next).text).toBe('second reply');
    const third = call(2);
    expect(third.tool_choice).toBe('auto');
    expect(third.input.some((i) => i['type'] === 'function_call_output' && i['call_id'] === 'c9')).toBe(true);
    endChatSession(sid);
  });

  it('a failed documentation call does not fail the turn or the next one', async () => {
    const sid = 'chat_narrow_4';
    start(sid);
    createMock
      .mockResolvedValueOnce({ output_text: 'first reply', output: [] })
      .mockRejectedValueOnce(new Error('upstream 500'))
      .mockResolvedValueOnce({ output_text: 'second reply', output: [] });
    expect((await sendMessage(sid, 'Yes', { narrowCrisisTurn: true })).text).toBe('first reply');
    expect((await sendMessage(sid, 'still here')).text).toBe('second reply');
    endChatSession(sid);
  });

  it('a session that ended while the documentation ran is not brought back', async () => {
    const sid = 'chat_narrow_5';
    start(sid);
    let releaseDoc: (value: unknown) => void = () => undefined;
    createMock
      .mockResolvedValueOnce({ output_text: 'first reply', output: [] })
      .mockImplementationOnce(() => new Promise((resolve) => (releaseDoc = resolve)));
    await sendMessage(sid, 'Yes', { narrowCrisisTurn: true });
    const settled = _narrowTurnDocumentationSettled(sid);
    endChatSession(sid);
    releaseDoc({
      output_text: '',
      output: [{ type: 'function_call', name: 'run_risk_check', call_id: 'c1', arguments: '{}' }],
    });
    await settled;
    expect(getConversationHistory(sid)).toEqual([]);
  });

  it('an ordinary turn is unchanged: tools on offer, the tool loop runs before the reply', async () => {
    const sid = 'chat_ordinary';
    start(sid);
    createMock
      .mockResolvedValueOnce({
        output_text: '',
        output: [{ type: 'function_call', name: 'run_risk_check', call_id: 'c1', arguments: '{}' }],
      })
      .mockResolvedValueOnce({ output_text: 'reply after tools', output: [] });
    const result = await sendMessage(sid, 'Yes');
    expect(call(0).tool_choice).toBe('auto');
    expect(call(0).tools?.length).toBe(TOOLS.length);
    expect(result.text).toBe('reply after tools');
    expect(createMock).toHaveBeenCalledTimes(2);
    endChatSession(sid);
  });
});
