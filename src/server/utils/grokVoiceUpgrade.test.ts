import { describe, it, expect } from 'vitest';
import { parseGrokVoicePath } from './grokVoiceUpgrade.js';

describe('parseGrokVoicePath', () => {
  const id = 'grok_5f48815a-74c7-444e-8469-94c8e04a0bfa';

  it('extracts a well-formed session id', () => {
    expect(parseGrokVoicePath(`/api/grok/voice/${id}`)).toBe(id);
    expect(parseGrokVoicePath(`/api/grok/voice/${id}?x=1`)).toBe(id);
    expect(parseGrokVoicePath(`/api/grok/voice/${encodeURIComponent(id)}`)).toBe(id);
  });

  it('ignores every other path so Socket.io and Vite keep their upgrades', () => {
    expect(parseGrokVoicePath('/socket.io/?EIO=4&transport=websocket')).toBeNull();
    expect(parseGrokVoicePath('/')).toBeNull();
    expect(parseGrokVoicePath(undefined)).toBeNull();
    expect(parseGrokVoicePath('/api/grok/voice/')).toBeNull();
  });

  it('rejects ids that are not ours (no path traversal, no foreign namespaces)', () => {
    expect(parseGrokVoicePath('/api/grok/voice/live_abc')).toBeNull();
    expect(parseGrokVoicePath(`/api/grok/voice/${id}/extra`)).toBeNull();
    expect(parseGrokVoicePath('/api/grok/voice/grok_%ZZ')).toBeNull();
    expect(parseGrokVoicePath('/api/grok/voice/grok_not-a-uuid')).toBeNull();
  });
});
