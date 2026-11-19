import { describe, it, expect } from 'vitest';
import { describeHandoffLink, type HandoffLink } from './SessionHandoffLinks';

const base: HandoffLink = {
  at: '2026-11-19T21:40:00Z',
  event: 'voice_cut_text_handoff',
  role: null,
  from: null,
  to: null,
  unlinkedFrom: null,
  reason: 'content',
  kind: null,
  severity: null,
  participantSeverity: null,
  source: null,
};

// A reviewer follows voice -> cut -> chat (-> voice) from the admin session view
// (PR #77 review, item 7).
describe('describeHandoffLink', () => {
  it('on the cut voice call: names the cause and the chat it went on in', () => {
    expect(describeHandoffLink({ ...base, role: 'cut_session', to: 'chat_9' })).toEqual({
      text: "Ended by the voice service's content filter; the conversation continued in typed chat",
      other: 'chat_9',
    });
  });

  it('on the chat: names the voice call, the first message and both risk readings', () => {
    const { text, other } = describeHandoffLink({
      ...base,
      role: 'continuation',
      from: 'live_1',
      kind: 'checkin',
      severity: 'none',
      participantSeverity: 'high',
    });
    expect(other).toBe('live_1');
    expect(text).toMatch(/check-in/);
    expect(text).toMatch(/risk in that call: none/);
    expect(text).toMatch(/participant, last 2 h: high/);
  });

  it('a browser-fallback chat whose call was not linkable says so', () => {
    const { text, other } = describeHandoffLink({
      ...base,
      role: 'continuation',
      unlinkedFrom: 'live_x',
      kind: 'crisis',
      severity: 'unknown',
      source: 'client_fallback',
    });
    expect(other).toBe('live_x');
    expect(text).toMatch(/not linked/);
    expect(text).toMatch(/browser fallback/);
  });

  it('a voice call started again from a chat points back at the chat', () => {
    expect(describeHandoffLink({ ...base, event: 'voice_resumed_from_text', from: 'chat_9' })).toEqual({
      text: 'Voice call started again from the hand-off chat',
      other: 'chat_9',
    });
  });

  it('the time limit is named as such', () => {
    expect(describeHandoffLink({ ...base, role: 'cut_session', reason: 'expired', to: 'c' }).text).toMatch(
      /session time limit/,
    );
  });
});
