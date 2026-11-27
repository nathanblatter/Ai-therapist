import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_QUIET_CHECK_IN_AFTER_MS,
  LIVE_QUIET_CHECK_IN_COMMENTARY,
  LIVE_QUIET_CHECK_IN_MAX_PER_SESSION,
  _resetQuietCheckInForTests,
  clearQuietCheckIn,
  noteAssistantTurnForQuietCheckIn,
  noteParticipantSpeechForQuietCheckIn,
  stopQuietCheckIn,
  type QuietCheckInDeps,
  type QuietCheckInRecord,
} from './liveQuietCheckIn.service.js';

const S = 'sess-quiet-0001';
const QUESTION = "I'm here with you. Are you having thoughts of suicide?";
const T0 = 1_800_000_000_000;

interface Call {
  open: boolean;
  assistantAt: number;
  participantAt: number;
  said: string[];
  records: QuietCheckInRecord[];
  sayFails: boolean;
}

function call(): { state: Call; deps: QuietCheckInDeps } {
  const state: Call = { open: true, assistantAt: 0, participantAt: 0, said: [], records: [], sayFails: false };
  const deps: QuietCheckInDeps = {
    isOpen: () => state.open,
    lastAssistantSpeechAt: () => state.assistantAt,
    lastParticipantSpeechAt: () => state.participantAt,
    say: async (_id, text) => {
      if (state.sayFails) throw new Error('socket closed');
      state.said.push(text);
      return true;
    },
    record: (_id, info) => {
      state.records.push(info);
    },
    asksSafetyQuestion: (text) => text.includes('?') && /suicid|safe/.test(text),
  };
  return { state, deps };
}

/** The assistant finishes a turn now. */
async function assistantSays(c: ReturnType<typeof call>, text: string): Promise<void> {
  c.state.assistantAt = Date.now();
  await noteAssistantTurnForQuietCheckIn(S, text, c.deps);
}

/** The participant says something now. */
function participantSpeaks(c: ReturnType<typeof call>): void {
  c.state.participantAt = Date.now();
  noteParticipantSpeechForQuietCheckIn(S);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  _resetQuietCheckInForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _resetQuietCheckInForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the wording', () => {
  it('asks for one short sentence and forbids repeating the question', () => {
    expect(LIVE_QUIET_CHECK_IN_COMMENTARY).toContain("Take your time. I'm still here with you.");
    expect(LIVE_QUIET_CHECK_IN_COMMENTARY).toContain('Do not repeat your question');
  });
});

describe('quiet check-in after a safety question', () => {
  it('speaks once when nobody has spoken for the quiet period', async () => {
    const c = call();
    await assistantSays(c, QUESTION);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS - 1_000);
    expect(c.state.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.state.said).toEqual([LIVE_QUIET_CHECK_IN_COMMENTARY]);
    expect(c.state.records).toEqual([{ quietMs: LIVE_QUIET_CHECK_IN_AFTER_MS, delivered: true, count: 1 }]);
  });

  it('does nothing after a turn that asks no safety question', async () => {
    const c = call();
    await assistantSays(c, 'That sounds like a rough week. What has been the hardest part?');
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 3);
    expect(c.state.said).toEqual([]);
  });

  it('is cancelled by the participant speaking', async () => {
    const c = call();
    await assistantSays(c, QUESTION);
    await vi.advanceTimersByTimeAsync(8_000);
    participantSpeaks(c);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 3);
    expect(c.state.said).toEqual([]);
  });

  it('is not armed when the participant was already answering as the turn closed', async () => {
    const c = call();
    c.state.assistantAt = Date.now();
    await vi.advanceTimersByTimeAsync(600);
    c.state.participantAt = Date.now();
    await noteAssistantTurnForQuietCheckIn(S, QUESTION, c.deps);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(c.state.said).toEqual([]);
  });

  it('counts the quiet period from the last words the assistant spoke', async () => {
    const c = call();
    await assistantSays(c, QUESTION);
    await vi.advanceTimersByTimeAsync(15_000);
    // More speech that is not a question (the rest of a reply): no new watch, but the clock restarts.
    await assistantSays(c, 'There is no hurry.');
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS - 1_000);
    expect(c.state.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.state.said).toHaveLength(1);
  });

  it('is sent once per silence, even if the check-in itself asks again', async () => {
    const c = call();
    await assistantSays(c, QUESTION);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS);
    expect(c.state.said).toHaveLength(1);
    await assistantSays(c, 'Take your time. Are you safe right now?');
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 5);
    expect(c.state.said).toHaveLength(1);
  });

  it('can check in again after the participant has spoken, up to the session cap', async () => {
    const c = call();
    for (let i = 0; i < LIVE_QUIET_CHECK_IN_MAX_PER_SESSION + 2; i++) {
      await assistantSays(c, QUESTION);
      await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS);
      participantSpeaks(c);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(c.state.said).toHaveLength(LIVE_QUIET_CHECK_IN_MAX_PER_SESSION);
    expect(c.state.records.map((r) => r.count)).toEqual(
      Array.from({ length: LIVE_QUIET_CHECK_IN_MAX_PER_SESSION }, (_, i) => i + 1),
    );
  });

  it('sends nothing into a call that has closed, or after it was stopped or cleared', async () => {
    const closed = call();
    await assistantSays(closed, QUESTION);
    closed.state.open = false;
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(closed.state.said).toEqual([]);

    const stopped = call();
    await assistantSays(stopped, QUESTION);
    stopQuietCheckIn(S);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(stopped.state.said).toEqual([]);

    const cleared = call();
    await assistantSays(cleared, QUESTION);
    clearQuietCheckIn(S);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 2);
    expect(cleared.state.said).toEqual([]);
  });

  it('records a check-in that could not be sent, and does not retry it', async () => {
    const c = call();
    c.state.sayFails = true;
    await assistantSays(c, QUESTION);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS * 3);
    expect(c.state.records).toEqual([{ quietMs: LIVE_QUIET_CHECK_IN_AFTER_MS, delivered: false, count: 1 }]);
  });

  it('uses the crisis pipeline screen by default', async () => {
    const c = call();
    const { asksSafetyQuestion: _unused, ...deps } = c.deps;
    void _unused;
    c.state.assistantAt = Date.now();
    await noteAssistantTurnForQuietCheckIn(S, 'Have you been having thoughts of suicide?', deps);
    await vi.advanceTimersByTimeAsync(LIVE_QUIET_CHECK_IN_AFTER_MS);
    expect(c.state.said).toHaveLength(1);
  });
});
