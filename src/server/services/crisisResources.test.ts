import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  emitCrisisResources,
  hasEmittedHighRiskResources,
  clearCrisisResourceState,
  noteParticipantJoined,
  CRISIS_RESOURCE_DEDUPE_MS,
  CRISIS_RESOURCE_JOIN_REPLAY_MS,
} from './crisisResources.js';

// The participant-facing crisis resource card event (ai-therapist-293).
const emit = vi.fn();
const to = vi.fn(() => ({ emit }));

beforeEach(() => {
  vi.clearAllMocks();
  clearCrisisResourceState();
  (global as unknown as { io: unknown }).io = { to };
});

afterEach(() => {
  delete (global as unknown as { io?: unknown }).io;
});

describe('emitCrisisResources', () => {
  it("emits session:crisis-emergency to the participant's session room", () => {
    expect(emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high', riskScore: 88 }, 1_000)).toBe(true);
    expect(to).toHaveBeenCalledWith('session:live_1');
    expect(emit).toHaveBeenCalledWith('session:crisis-emergency', {
      sessionId: 'live_1',
      severity: 'high',
      riskScore: 88,
      reason: 'high_risk',
    });
  });

  it('a vendor-only event carries no severity, so the browser does not read it as our own high flag', () => {
    emitCrisisResources('live_1', { reason: 'vendor_moderation_stop' }, 1_000);
    expect(emit).toHaveBeenCalledWith('session:crisis-emergency', {
      sessionId: 'live_1',
      severity: null,
      riskScore: null,
      reason: 'vendor_moderation_stop',
    });
  });

  it('drops a repeat of the same kind inside the window, and sends it again after', () => {
    expect(emitCrisisResources('live_1', { reason: 'vendor_moderation_stop' }, 1_000)).toBe(true);
    // The close that follows the moderation stop half a second later.
    expect(emitCrisisResources('live_1', { reason: 'vendor_cut' }, 1_600)).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emitCrisisResources('live_1', { reason: 'vendor_cut' }, 1_000 + CRISIS_RESOURCE_DEDUPE_MS)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('a vendor stop never swallows the high flag that follows it', () => {
    emitCrisisResources('live_1', { reason: 'vendor_moderation_stop' }, 1_000);
    expect(emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high', riskScore: 90 }, 1_200)).toBe(true);
    expect(emit).toHaveBeenLastCalledWith('session:crisis-emergency', expect.objectContaining({ severity: 'high' }));
  });

  it('keeps sessions separate', () => {
    emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high' }, 1_000);
    expect(emitCrisisResources('live_2', { reason: 'high_risk', severity: 'high' }, 1_001)).toBe(true);
  });

  it('tracks whether the high-flag card has gone out, per session, until cleared', () => {
    expect(hasEmittedHighRiskResources('live_1')).toBe(false);
    emitCrisisResources('live_1', { reason: 'vendor_cut' }, 1_000);
    expect(hasEmittedHighRiskResources('live_1')).toBe(false);
    emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high' }, 1_000);
    expect(hasEmittedHighRiskResources('live_1')).toBe(true);
    clearCrisisResourceState('live_1');
    expect(hasEmittedHighRiskResources('live_1')).toBe(false);
  });

  it('returns false, without throwing, when there is no socket server', () => {
    delete (global as unknown as { io?: unknown }).io;
    expect(emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high' })).toBe(false);
    // Nothing was recorded, so the first real emission is not deduplicated away.
    (global as unknown as { io: unknown }).io = { to };
    expect(emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high' })).toBe(true);
  });

  it('never throws when the socket server does', () => {
    (global as unknown as { io: unknown }).io = {
      to: () => {
        throw new Error('adapter down');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(emitCrisisResources('live_1', { reason: 'vendor_cut' })).toBe(false);
    spy.mockRestore();
  });
});

// Review of PR 65: a pre-session check-in is scored while the session is being
// started, before the participant's browser has joined the session room.
describe('a high flag raised before the participant has joined the room', () => {
  it('REPRODUCTION: the card is held and sent to the first participant socket that joins', () => {
    emitCrisisResources('chat_checkin', { reason: 'high_risk', severity: 'high', riskScore: 85 }, 1_000);
    // The room emit went out (to nobody), and the pipeline now believes the card was shown.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(hasEmittedHighRiskResources('chat_checkin')).toBe(true);

    const send = vi.fn();
    expect(noteParticipantJoined('chat_checkin', send, 3_000)).toBe(true);
    expect(send).toHaveBeenCalledWith('session:crisis-emergency', {
      sessionId: 'chat_checkin',
      severity: 'high',
      riskScore: 85,
      reason: 'high_risk',
    });
  });

  it('is sent once: a reconnect does not re-open a card the participant closed', () => {
    emitCrisisResources('chat_checkin', { reason: 'high_risk', severity: 'high', riskScore: 85 }, 1_000);
    const send = vi.fn();
    noteParticipantJoined('chat_checkin', send, 2_000);
    expect(noteParticipantJoined('chat_checkin', send, 5_000)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a high flag raised after the participant joined is not replayed (the room emit reached them)', () => {
    const send = vi.fn();
    expect(noteParticipantJoined('live_1', send, 1_000)).toBe(false);
    emitCrisisResources('live_1', { reason: 'high_risk', severity: 'high', riskScore: 80 }, 2_000);
    expect(noteParticipantJoined('live_1', send, 3_000)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('a vendor-only event is not held, and a stale card is not sent', () => {
    const send = vi.fn();
    emitCrisisResources('s_vendor', { reason: 'vendor_cut' }, 1_000);
    expect(noteParticipantJoined('s_vendor', send, 2_000)).toBe(false);
    emitCrisisResources('s_old', { reason: 'high_risk', severity: 'high', riskScore: 90 }, 1_000);
    expect(noteParticipantJoined('s_old', send, 1_000 + CRISIS_RESOURCE_JOIN_REPLAY_MS + 1)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the socket does', () => {
    emitCrisisResources('s_throw', { reason: 'high_risk', severity: 'high', riskScore: 90 }, 1_000);
    expect(
      noteParticipantJoined(
        's_throw',
        () => {
          throw new Error('socket closed');
        },
        2_000,
      ),
    ).toBe(false);
  });
});
