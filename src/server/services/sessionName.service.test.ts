import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OpenAI client so constructing it (at module import) and any
// chat.completions.create call are inert and observable.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

// Mock the DB barrel used both at import time and via dynamic import().
const { getSessionMock, getSessionMessagesMock, updateSessionNameMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getSessionMessagesMock: vi.fn(),
  updateSessionNameMock: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  getSession: getSessionMock,
  getSessionMessages: getSessionMessagesMock,
  updateSessionName: updateSessionNameMock,
}));

import {
  buildConversationText,
  isJunkSessionName,
  generateSessionName,
} from './sessionName.service.js';

beforeEach(() => {
  createMock.mockReset();
  getSessionMock.mockReset();
  getSessionMessagesMock.mockReset();
  updateSessionNameMock.mockReset();
  updateSessionNameMock.mockResolvedValue({});
});

describe('buildConversationText', () => {
  it('includes only user/assistant turns, preferring redacted content', () => {
    const text = buildConversationText([
      { role: 'user', content: 'raw-user', content_redacted: 'safe-user' },
      { role: 'assistant', content: 'raw-asst', content_redacted: null },
      { role: 'system', content: 'ignored', content_redacted: 'ignored' },
    ]);
    expect(text).toBe('user: safe-user\nassistant: raw-asst');
  });

  it('returns blank when all redacted content is empty (pre-redaction case)', () => {
    const text = buildConversationText([
      { role: 'user', content: null, content_redacted: null },
      { role: 'assistant', content: '', content_redacted: null },
    ]);
    expect(text.trim()).toBe('');
  });
});

describe('isJunkSessionName', () => {
  it('treats empty/placeholder/refusal names as junk (retryable)', () => {
    expect(isJunkSessionName(null)).toBe(true);
    expect(isJunkSessionName('   ')).toBe(true);
    expect(isJunkSessionName('Therapy session')).toBe(true);
    expect(isJunkSessionName('Please provide the details of the therapy session')).toBe(true);
    expect(isJunkSessionName("I'm sorry, I cannot help with that")).toBe(true);
  });

  it('treats a real title as not junk', () => {
    expect(isJunkSessionName('Coping with work anxiety')).toBe(false);
  });
});

describe('generateSessionName blank-transcript guard', () => {
  it('skips the LLM call and does NOT write a name when the transcript is blank', async () => {
    getSessionMock.mockResolvedValue({ session_id: 's1', session_name: null });
    // Pre-redaction: redacted content all null → blank transcript.
    getSessionMessagesMock.mockResolvedValue([
      { role: 'user', content: null, content_redacted: null },
      { role: 'assistant', content: null, content_redacted: null },
    ]);

    const result = await generateSessionName('s1');

    expect(result).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(updateSessionNameMock).not.toHaveBeenCalled();
  });

  it('regenerates over a previously written junk name (retry) once content exists', async () => {
    getSessionMock.mockResolvedValue({ session_id: 's1', session_name: 'Therapy session' });
    getSessionMessagesMock.mockResolvedValue([
      { role: 'user', content: null, content_redacted: 'I feel anxious about work' },
      { role: 'assistant', content: null, content_redacted: 'Tell me more about that' },
    ]);
    createMock.mockResolvedValue({ choices: [{ message: { content: 'Coping with work anxiety' } }] });

    const result = await generateSessionName('s1');

    expect(createMock).toHaveBeenCalledOnce();
    expect(updateSessionNameMock).toHaveBeenCalledWith('s1', 'Coping with work anxiety');
    expect(result).toBe('Coping with work anxiety');
  });
});
