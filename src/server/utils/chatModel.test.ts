import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSystemConfigMock } = vi.hoisted(() => ({ getSystemConfigMock: vi.fn() }));
vi.mock('./sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));
const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('./logger.js', () => ({ createLogger: () => logMock }));

const { CHAT_DEFAULT_MODEL, chatModelFromConfig, resolveChatModel } = await import('./chatModel.js');

beforeEach(() => {
  logMock.warn.mockClear();
});

describe('chatModelFromConfig', () => {
  it('keeps gpt-5.2 as the code default so merging changes nothing', () => {
    expect(CHAT_DEFAULT_MODEL).toBe('gpt-5.2');
    expect(chatModelFromConfig({})).toBe('gpt-5.2');
    expect(chatModelFromConfig(null)).toBe('gpt-5.2');
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('reads a bare string, like live_backend_model', () => {
    expect(chatModelFromConfig({ chat_model: 'gpt-6.1-terra' })).toBe('gpt-6.1-terra');
    expect(chatModelFromConfig({ chat_model: '  gpt-6.1-terra ' })).toBe('gpt-6.1-terra');
  });

  it('accepts a dated snapshot of a registered model', () => {
    expect(chatModelFromConfig({ chat_model: 'gpt-6.1-terra-2026-10-01' })).toBe('gpt-6.1-terra-2026-10-01');
  });

  it('ignores blank or non-string values', () => {
    expect(chatModelFromConfig({ chat_model: '' })).toBe('gpt-5.2');
    expect(chatModelFromConfig({ chat_model: { model: 'gpt-6.1-terra' } })).toBe('gpt-5.2');
  });

  it('logs a non-string value rather than ignoring it silently', () => {
    expect(chatModelFromConfig({ chat_model: 52 })).toBe('gpt-5.2');
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default, and logs, for a model id that is not in the registry (a typo)', () => {
    // Forwarded as-is, a typo would 404 every chat turn of every new session.
    expect(chatModelFromConfig({ chat_model: 'gpt-6.1-tera' })).toBe('gpt-5.2');
    expect(chatModelFromConfig({ chat_model: 'gpt-5.22' })).toBe('gpt-5.2');
    expect(logMock.warn).toHaveBeenCalledTimes(2);
  });
});

describe('resolveChatModel', () => {
  it('falls back to the default when config cannot be read', async () => {
    getSystemConfigMock.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveChatModel()).resolves.toBe('gpt-5.2');
  });

  it('returns the configured model', async () => {
    getSystemConfigMock.mockResolvedValueOnce({ chat_model: 'gpt-6.1-terra' });
    await expect(resolveChatModel()).resolves.toBe('gpt-6.1-terra');
  });

  it('never hands an unknown model to session start', async () => {
    getSystemConfigMock.mockResolvedValueOnce({ chat_model: 'not-a-model' });
    await expect(resolveChatModel()).resolves.toBe('gpt-5.2');
  });
});
