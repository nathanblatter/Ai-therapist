import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the input the Responses API is called with, so we can assert that
// injected clinical guidance rides along in the right position.
const { createMock, getEnabledToolDefinitionsMock, executeLoggedToolCallMock, recordLlmUsageMock, insertTurnLatencyMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getEnabledToolDefinitionsMock: vi.fn(),
  executeLoggedToolCallMock: vi.fn(),
  recordLlmUsageMock: vi.fn(),
  insertTurnLatencyMock: vi.fn(),
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
vi.mock('./toolExecution.helpers.js', () => ({
  executeLoggedToolCall: executeLoggedToolCallMock,
}));
vi.mock('../db/index.js', () => ({
  recordLlmUsage: recordLlmUsageMock,
  insertTurnLatency: insertTurnLatencyMock,
}));

const {
  initializeChatSession, sendMessage, injectGuidance, getConversationHistory, endChatSession,
  toResponsesTools,
} = await import('./chatTherapy.service.js');

const SAMPLE_DEF = {
  type: 'function',
  name: 'show_resource_card',
  description: 'Show a resource card.',
  parameters: { type: 'object', properties: { resource_type: { type: 'string' } }, required: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ output_text: 'assistant reply', output: [] });
  getEnabledToolDefinitionsMock.mockResolvedValue([SAMPLE_DEF]);
  executeLoggedToolCallMock.mockResolvedValue({ result: { success: true }, success: true });
  recordLlmUsageMock.mockResolvedValue(undefined);
  insertTurnLatencyMock.mockResolvedValue(undefined);
});

describe('injectGuidance', () => {
  it('is a no-op for an unknown session', () => {
    expect(() => injectGuidance('missing_session', 'guidance')).not.toThrow();
    expect(getConversationHistory('missing_session')).toEqual([]);
  });

  it('places injected system guidance before the latest user turn in the model input', async () => {
    const sid = 'chat_inject';
    initializeChatSession(sid, 'SYSTEM PROMPT');
    injectGuidance(sid, 'CLINICAL GUIDANCE');
    await sendMessage(sid, 'hello there');

    const input = createMock.mock.calls[0][0].input as Array<{ role: string; content: string }>;
    // system prompt first, guidance somewhere before the final user message.
    expect(input[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    const guidanceIdx = input.findIndex(m => m.content === 'CLINICAL GUIDANCE');
    const lastUserIdx = input.map(m => m.role).lastIndexOf('user');
    expect(guidanceIdx).toBeGreaterThan(0);
    expect(guidanceIdx).toBeLessThan(lastUserIdx);
    expect(input[lastUserIdx].content).toBe('hello there');
    endChatSession(sid);
  });
});

describe('toResponsesTools', () => {
  it('converts realtime-shaped definitions to Responses function tools with strict off', () => {
    const tools = toResponsesTools([SAMPLE_DEF]);
    expect(tools).toEqual([{
      type: 'function',
      name: 'show_resource_card',
      description: 'Show a resource card.',
      parameters: SAMPLE_DEF.parameters,
      strict: false,
    }]);
  });
});

describe('chat tool calling (ai-therapist-118)', () => {
  it('passes the chat-channel tool subset and tool_choice auto to responses.create', async () => {
    const sid = 'chat_tools_1';
    initializeChatSession(sid, 'SYSTEM');
    await sendMessage(sid, 'hi');

    expect(getEnabledToolDefinitionsMock).toHaveBeenCalledWith({ channel: 'chat' });
    const opts = createMock.mock.calls[0][0];
    expect(opts.tool_choice).toBe('auto');
    expect(opts.tools).toEqual(toResponsesTools([SAMPLE_DEF]));
    endChatSession(sid);
  });

  it('replies without tools when the registry lookup fails (fail-open)', async () => {
    getEnabledToolDefinitionsMock.mockRejectedValue(new Error('config down'));
    const sid = 'chat_tools_failopen';
    initializeChatSession(sid, 'SYSTEM');
    const { text } = await sendMessage(sid, 'hi');
    expect(text).toBe('assistant reply');
    const opts = createMock.mock.calls[0][0];
    expect(opts.tools).toBeUndefined();
    expect(opts.tool_choice).toBeUndefined();
    endChatSession(sid);
  });

  it('executes function calls via the registry, feeds outputs back, and surfaces visual toolEvents', async () => {
    const sid = 'chat_tools_2';
    initializeChatSession(sid, 'SYSTEM');

    createMock
      .mockResolvedValueOnce({
        output_text: '',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'show_resource_card', arguments: '{"resource_type":"suicide"}' },
          { type: 'function_call', call_id: 'call_2', name: 'remember_this', arguments: '{"fact":"has a dog"}' },
        ],
      })
      .mockResolvedValueOnce({ output_text: 'here are some resources', output: [] });

    const { text, toolEvents } = await sendMessage(sid, 'I feel unsafe');

    expect(text).toBe('here are some resources');
    expect(executeLoggedToolCallMock).toHaveBeenCalledTimes(2);
    expect(executeLoggedToolCallMock).toHaveBeenNthCalledWith(
      1, sid, 'show_resource_card', { resource_type: 'suicide' }, 'call_1', 'chat');
    expect(executeLoggedToolCallMock).toHaveBeenNthCalledWith(
      2, sid, 'remember_this', { fact: 'has a dog' }, 'call_2', 'chat');

    // Only client-renderable tools ride back to the browser.
    expect(toolEvents).toEqual([
      { name: 'show_resource_card', args: { resource_type: 'suicide' }, result: { success: true } },
    ]);

    // Second model call sees the function_call + function_call_output items.
    const secondInput = createMock.mock.calls[1][0].input as Array<Record<string, unknown>>;
    expect(secondInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'show_resource_card' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ success: true }) }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_2' }),
    ]));

    // The function items persist in history so later turns keep the context.
    const history = getConversationHistory(sid) as Array<Record<string, unknown>>;
    expect(history.some(h => h['type'] === 'function_call_output' && h['call_id'] === 'call_2')).toBe(true);
    expect(history[history.length - 1]).toEqual({ role: 'assistant', content: 'here are some resources' });
    endChatSession(sid);
  });

  it('caps tool rounds and forces a text reply with tool_choice none on the last round', async () => {
    const sid = 'chat_tools_cap';
    initializeChatSession(sid, 'SYSTEM');

    // Model keeps calling tools forever.
    let n = 0;
    createMock.mockImplementation(async () => ({
      output_text: 'final text',
      output: [{ type: 'function_call', call_id: `call_${n++}`, name: 'show_resource_card', arguments: '{}' }],
    }));

    const { text } = await sendMessage(sid, 'loop');
    expect(text).toBe('final text');
    // 1 initial call + 5 tool rounds = 6 model calls, 5 executions.
    expect(createMock).toHaveBeenCalledTimes(6);
    expect(executeLoggedToolCallMock).toHaveBeenCalledTimes(5);
    expect(createMock.mock.calls[5][0].tool_choice).toBe('none');
    endChatSession(sid);
  });

  it('records chat LLM usage per model call (fire-and-forget)', async () => {
    const sid = 'chat_usage';
    initializeChatSession(sid, 'SYSTEM');
    createMock.mockResolvedValue({ output_text: 'ok', output: [], usage: { input_tokens: 100, output_tokens: 20 } });

    await sendMessage(sid, 'hi');
    await vi.waitFor(() => expect(recordLlmUsageMock).toHaveBeenCalled());
    expect(recordLlmUsageMock).toHaveBeenCalledWith(sid, 'chat', 'gpt-5.2', 100, 20);
    endChatSession(sid);
  });

  it('records one turn_latency row per turn with ttfa == total (telemetry pass 3)', async () => {
    const sid = 'chat_latency';
    initializeChatSession(sid, 'SYSTEM');
    createMock
      .mockResolvedValueOnce({
        output_text: '',
        output: [{ type: 'function_call', call_id: 'call_1', name: 'show_resource_card', arguments: '{}' }],
      })
      .mockResolvedValueOnce({ output_text: 'done', output: [] });

    await sendMessage(sid, 'first turn');
    await vi.waitFor(() => expect(insertTurnLatencyMock).toHaveBeenCalledTimes(1));

    // One row for the whole turn even though the tool loop made two model calls.
    const row = insertTurnLatencyMock.mock.calls[0][0];
    expect(row.sessionId).toBe(sid);
    expect(row.channel).toBe('chat');
    expect(row.turnIndex).toBe(1);
    // Non-streaming: first output == response done == end of the tool loop.
    expect(row.firstOutputAt).toEqual(row.responseDoneAt);
    expect(row.responseDoneAt.getTime()).toBeGreaterThanOrEqual(row.userDoneAt.getTime());

    await sendMessage(sid, 'second turn');
    await vi.waitFor(() => expect(insertTurnLatencyMock).toHaveBeenCalledTimes(2));
    expect(insertTurnLatencyMock.mock.calls[1][0].turnIndex).toBe(2);
    endChatSession(sid);
  });

  it('executes a tool with empty args when the arguments string is unparseable', async () => {
    const sid = 'chat_badargs';
    initializeChatSession(sid, 'SYSTEM');
    createMock
      .mockResolvedValueOnce({
        output_text: '',
        output: [{ type: 'function_call', call_id: 'call_x', name: 'show_resource_card', arguments: 'not json' }],
      })
      .mockResolvedValueOnce({ output_text: 'done', output: [] });

    const { text } = await sendMessage(sid, 'hi');
    expect(text).toBe('done');
    expect(executeLoggedToolCallMock).toHaveBeenCalledWith(sid, 'show_resource_card', {}, 'call_x', 'chat');
    endChatSession(sid);
  });
});
