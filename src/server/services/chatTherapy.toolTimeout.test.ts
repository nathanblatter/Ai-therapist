import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A slow crisis tool in a typed-chat turn (PR #80 review). The real tool
// registry and logged executor run; only the model, the database and the
// crisis service are mocked, and the crisis flag write hangs (a wedged pool).
// The turn must still produce the assistant's reply, the model must be told
// the alert is still being sent (never that it failed), and the model asking
// again must not start a second escalation.
const { createMock, flagSessionCrisisMock, logInterventionActionMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  flagSessionCrisisMock: vi.fn(),
  logInterventionActionMock: vi.fn(),
}));

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    responses = { create: createMock };
  },
}));
vi.mock('../config/db.js', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('../utils/sessionHelpers.js', () => ({ getSystemConfig: vi.fn().mockResolvedValue({ features: {} }) }));
vi.mock('../utils/adminBroadcast.js', () => ({ broadcastAdminEventForSession: vi.fn() }));
vi.mock('../utils/chatModel.js', () => ({ resolveChatModel: vi.fn().mockResolvedValue('gpt-test') }));
vi.mock('../utils/safetyIdentifier.js', () => ({ safetyIdentifierForSession: async () => 'sid-hash' }));
vi.mock('../db/index.js', () => ({
  recordLlmUsage: vi.fn().mockResolvedValue(undefined),
  insertTurnLatency: vi.fn().mockResolvedValue(undefined),
  insertMessagesBatch: vi.fn().mockResolvedValue(undefined),
  insertToolInvocation: vi.fn().mockResolvedValue(undefined),
  getSessionAccessInfo: vi.fn(),
  getSessionConfig: vi.fn(),
  getSessionMessages: vi.fn(),
}));
vi.mock('./crisisDetection.service.js', () => ({
  flagSessionCrisis: flagSessionCrisisMock,
  logInterventionAction: logInterventionActionMock,
}));
vi.mock('./crisisIntervention.service.js', () => ({ executeGraduatedResponse: vi.fn().mockResolvedValue(undefined) }));

const { initializeChatSession, sendMessage, getConversationHistory, endChatSession } = await import(
  './chatTherapy.service.js'
);
const { toolTimeoutMs, toolTimeoutMessage } = await import('./toolTimeouts.js');
// Loaded up front: the turn imports these lazily, and a module load is real
// time the fake clock below would race past.
await Promise.all([
  import('./toolRegistry.service.js'),
  import('./toolExecution.helpers.js'),
  import('./crisisDetection.service.js'),
  import('./crisisIntervention.service.js'),
]);

const escalateCall = (id: string) => ({
  type: 'function_call',
  name: 'escalate_to_human',
  call_id: id,
  arguments: '{"reason":"Participant says they have a plan for tonight.","urgency":"high"}',
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  flagSessionCrisisMock.mockImplementation(() => new Promise(() => {})); // never settles
  logInterventionActionMock.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a typed-chat crisis turn whose escalate_to_human hangs', () => {
  it('still returns the reply, tells the model the alert is still being sent, and never escalates twice', async () => {
    const sid = 'chat_tool_timeout_1';
    initializeChatSession(sid, 'SYSTEM PROMPT', 'gpt-test');
    createMock
      .mockResolvedValueOnce({ output_text: '', output: [escalateCall('c1')] })
      // The model, told it is still being sent, tries again anyway.
      .mockResolvedValueOnce({ output_text: '', output: [escalateCall('c2')] })
      .mockResolvedValueOnce({ output_text: 'I am here with you. You can call or text 988 right now.', output: [] });

    let done = false;
    const turn = sendMessage(sid, 'I have a plan for tonight.').finally(() => (done = true));
    // The first call times out at its limit; the repeat is answered at once.
    for (let waited = 0; !done && waited <= 2 * toolTimeoutMs('escalate_to_human'); waited += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const result = await turn;

    expect(result.text).toBe('I am here with you. You can call or text 988 right now.');
    expect(createMock).toHaveBeenCalledTimes(3);
    // One escalation started, however many times the model asked.
    expect(flagSessionCrisisMock).toHaveBeenCalledTimes(1);

    const outputs = (getConversationHistory(sid) as Array<Record<string, unknown>>)
      .filter((m) => m['type'] === 'function_call_output')
      .map((m) => JSON.parse(String(m['output'])) as { error?: string; success?: boolean });
    expect(outputs).toHaveLength(2);
    for (const out of outputs) {
      expect(out.success).toBe(false);
      expect(out.error).toBe(toolTimeoutMessage('escalate_to_human'));
      expect(out.error).not.toMatch(/could not do it/);
    }
    endChatSession(sid);
  });
});
