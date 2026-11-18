import { describe, it, expect, vi } from 'vitest';

const { getSystemConfigMock } = vi.hoisted(() => ({ getSystemConfigMock: vi.fn() }));
vi.mock('./sessionHelpers.js', () => ({ getSystemConfig: getSystemConfigMock }));

const { CHAT_DEFAULT_MODEL, chatModelFromConfig, resolveChatModel } = await import('./chatModel.js');

describe('chatModelFromConfig', () => {
  it('keeps gpt-5.2 as the code default so merging changes nothing', () => {
    expect(CHAT_DEFAULT_MODEL).toBe('gpt-5.2');
    expect(chatModelFromConfig({})).toBe('gpt-5.2');
    expect(chatModelFromConfig(null)).toBe('gpt-5.2');
  });

  it('reads a bare string, like live_backend_model', () => {
    expect(chatModelFromConfig({ chat_model: 'gpt-6.1-terra' })).toBe('gpt-6.1-terra');
    expect(chatModelFromConfig({ chat_model: '  gpt-6.1-terra ' })).toBe('gpt-6.1-terra');
  });

  it('ignores blank or non-string values', () => {
    expect(chatModelFromConfig({ chat_model: '' })).toBe('gpt-5.2');
    expect(chatModelFromConfig({ chat_model: { model: 'gpt-6.1-terra' } })).toBe('gpt-5.2');
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
});
