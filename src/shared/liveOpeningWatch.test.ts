// The browser's half of the GPT-Live opening watch (ai-therapist-315): when it
// shows the opening's text itself, and what that text is.
import { describe, it, expect } from 'vitest';
import {
  LIVE_OPENING_CLIENT_BACKSTOP_MS,
  LIVE_OPENING_RETRIGGER_MS,
  LIVE_OPENING_UNSPOKEN_MS,
  clientOpeningFallbackDue,
  liveOpeningScreenText,
} from './liveOpeningWatch.js';
import { CHAT_OPENING_INVITATION, DEFAULT_CRISIS_CONTACT, liveOpeningInitialPrompt } from './openingPrompt.js';

const silent = {
  source: 'client' as const,
  now: LIVE_OPENING_CLIENT_BACKSTOP_MS,
  requestedAt: 0,
  assistantSpokeAt: null,
  participantSpokeAt: null,
  crisis: false,
  shown: false,
};

describe('the bounds', () => {
  it('re-trigger before give-up, and the browser backstop after the server gives up', () => {
    expect(LIVE_OPENING_RETRIGGER_MS).toBe(4_000);
    expect(LIVE_OPENING_UNSPOKEN_MS).toBe(8_000);
    expect(LIVE_OPENING_CLIENT_BACKSTOP_MS).toBeGreaterThan(LIVE_OPENING_UNSPOKEN_MS);
  });
});

describe('clientOpeningFallbackDue', () => {
  it('is due at the backstop when nothing was spoken, and not a millisecond earlier', () => {
    expect(clientOpeningFallbackDue(silent)).toBe(true);
    expect(clientOpeningFallbackDue({ ...silent, now: LIVE_OPENING_CLIENT_BACKSTOP_MS - 1 })).toBe(false);
  });

  it('never once the assistant has a caption (latch)', () => {
    expect(clientOpeningFallbackDue({ ...silent, assistantSpokeAt: 3_000 })).toBe(false);
  });

  it('never when the participant spoke first', () => {
    expect(clientOpeningFallbackDue({ ...silent, participantSpokeAt: 1_000 })).toBe(false);
  });

  it('never in a crisis', () => {
    expect(clientOpeningFallbackDue({ ...silent, crisis: true })).toBe(false);
  });

  it('never twice', () => {
    expect(clientOpeningFallbackDue({ ...silent, shown: true })).toBe(false);
  });

  it('the browser timer needs the confirmed request it times from', () => {
    expect(clientOpeningFallbackDue({ ...silent, requestedAt: null, now: 10 * LIVE_OPENING_CLIENT_BACKSTOP_MS })).toBe(
      false,
    );
  });

  describe("the server's signal (it already applied the bounds and the participant-first rule)", () => {
    const server = { ...silent, source: 'server' as const, now: LIVE_OPENING_UNSPOKEN_MS, requestedAt: null };

    it('shows at once, even if the browser never got the delivery answer', () => {
      expect(clientOpeningFallbackDue(server)).toBe(true);
    });

    it('still never over a caption, in a crisis, or twice', () => {
      expect(clientOpeningFallbackDue({ ...server, assistantSpokeAt: 1 })).toBe(false);
      expect(clientOpeningFallbackDue({ ...server, crisis: true })).toBe(false);
      expect(clientOpeningFallbackDue({ ...server, shown: true })).toBe(false);
    });
  });
});

describe('liveOpeningScreenText', () => {
  it('is exactly the words the voice model is told to say, with no new wording', () => {
    const text = liveOpeningScreenText(DEFAULT_CRISIS_CONTACT, false);
    expect(liveOpeningInitialPrompt('en', DEFAULT_CRISIS_CONTACT)).toBe(`Say this phrase exactly: '${text}'`);
  });

  it('ends with the typed-chat invitation when lead_conversation is on, as a typed-chat opening does', () => {
    const plain = liveOpeningScreenText(DEFAULT_CRISIS_CONTACT, false);
    expect(liveOpeningScreenText(DEFAULT_CRISIS_CONTACT, true)).toBe(`${plain} ${CHAT_OPENING_INVITATION}`);
  });
});
