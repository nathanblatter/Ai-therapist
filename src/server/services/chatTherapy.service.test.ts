import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the input the Responses API is called with, so we can assert that
// injected clinical guidance rides along in the right position.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('../config/secrets.js', () => ({ getOpenAIKey: vi.fn().mockResolvedValue('test-key') }));
vi.mock('openai', () => ({
  default: class {
    responses = { create: createMock };
  },
}));

const {
  initializeChatSession, sendMessage, injectGuidance, getConversationHistory, endChatSession,
} = await import('./chatTherapy.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ output_text: 'assistant reply' });
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
