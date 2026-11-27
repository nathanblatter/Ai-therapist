// Server-authored GPT-Live opening (ai-therapist-214). With the browser's data
// channel locked, this is the only way the AI disclosure preamble is spoken, so
// "delivered at most once, and retryable until it is" is the contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const sidebandMocks = vi.hoisted(() => ({ tryInject: vi.fn(), tryCommentary: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ insertMessage: vi.fn() }));

vi.mock('../utils/logger.js', () => ({ createLogger: () => logMock }));
vi.mock('./sidebandManager.service.js', () => ({ sidebandManager: sidebandMocks }));
vi.mock('../db/index.js', () => dbMocks);

import {
  registerLiveOpening,
  deliverLiveOpening,
  deliverLiveOpeningViaSideband,
  scheduleLiveOpeningFallback,
  clearLiveOpening,
  noteLiveOpeningAssistantSpeech,
  noteLiveOpeningParticipantSpeech,
  noteLiveOpeningCrisis,
  liveOpeningAwaitingSpeech,
  liveOpeningDelivery,
  _resetLiveOpeningsForTests,
  _setLiveOpeningWatchDepsForTests,
  _liveOpeningOutcomeForTests,
  type LiveOpeningTiming,
  type LiveOpeningWatchDeps,
} from './liveOpening.service.js';
import { LIVE_OPENING_RETRIGGER_MS, LIVE_OPENING_UNSPOKEN_MS } from '../../shared/liveOpeningWatch.js';

const ID = 'live_test_1';
const OPENING = { text: "Say this phrase exactly: 'Hello!'", logMessage: 'Initial prompt: hello' };

beforeEach(() => {
  vi.clearAllMocks();
  _resetLiveOpeningsForTests();
  sidebandMocks.tryInject.mockResolvedValue(true);
  sidebandMocks.tryCommentary.mockResolvedValue(true);
  dbMocks.insertMessage.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liveOpeningDelivery (LIVE_OPENING_DELIVERY)', () => {
  it('is the instructions append unless the recipe is asked for by name', () => {
    expect(liveOpeningDelivery({})).toBe('instructions');
    expect(liveOpeningDelivery({ LIVE_OPENING_DELIVERY: '' })).toBe('instructions');
    expect(liveOpeningDelivery({ LIVE_OPENING_DELIVERY: 'commentary' })).toBe('instructions');
    expect(liveOpeningDelivery({ LIVE_OPENING_DELIVERY: 'recipe' })).toBe('recipe');
    expect(liveOpeningDelivery({ LIVE_OPENING_DELIVERY: ' Recipe ' })).toBe('recipe');
  });
});

describe('deliverLiveOpening', () => {
  it('injects the registered text and reports the log line', async () => {
    registerLiveOpening(ID, OPENING);
    const inject = vi.fn().mockResolvedValue(true);

    const result = await deliverLiveOpening(ID, inject);

    expect(inject).toHaveBeenCalledWith(OPENING.text, 'instructions');
    expect(result).toEqual({ delivered: true, already: false, logMessage: OPENING.logMessage });
  });

  it('delivers a recovery opening as commentary, the documented greeting mechanism (ai-therapist-293)', async () => {
    registerLiveOpening(ID, { ...OPENING, via: 'commentary' });
    const inject = vi.fn().mockResolvedValue(true);

    await deliverLiveOpening(ID, inject);

    expect(inject).toHaveBeenCalledWith(OPENING.text, 'commentary');
  });

  it('never speaks the disclosure twice', async () => {
    registerLiveOpening(ID, OPENING);
    const inject = vi.fn().mockResolvedValue(true);

    await deliverLiveOpening(ID, inject);
    const second = await deliverLiveOpening(ID, inject);

    expect(inject).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ delivered: true, already: true, logMessage: null });
  });

  it('injects once when two requests overlap', async () => {
    registerLiveOpening(ID, OPENING);
    let release: (ok: boolean) => void = () => undefined;
    const inject = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => (release = resolve)));

    const first = deliverLiveOpening(ID, inject);
    const second = deliverLiveOpening(ID, inject);
    release(true);

    expect(await first).toMatchObject({ delivered: true, already: false });
    expect(await second).toMatchObject({ delivered: true, already: true });
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('stays retryable when the sideband could not send it', async () => {
    registerLiveOpening(ID, OPENING);

    const failed = await deliverLiveOpening(ID, vi.fn().mockResolvedValue(false));
    expect(failed).toEqual({ delivered: false, reason: 'sideband_unavailable' });

    const retried = await deliverLiveOpening(ID, vi.fn().mockResolvedValue(true));
    expect(retried).toMatchObject({ delivered: true, already: false });
  });

  it('treats a throwing inject as undelivered rather than as spoken', async () => {
    registerLiveOpening(ID, OPENING);

    const result = await deliverLiveOpening(ID, vi.fn().mockRejectedValue(new Error('socket closed')));

    expect(result).toEqual({ delivered: false, reason: 'sideband_unavailable' });
  });

  it('reports none_registered for a session with no opening, without injecting', async () => {
    const inject = vi.fn();

    expect(await deliverLiveOpening('live_unknown', inject)).toEqual({ delivered: false, reason: 'none_registered' });
    expect(inject).not.toHaveBeenCalled();
  });

  it('forgets a cleared opening', async () => {
    registerLiveOpening(ID, OPENING);
    clearLiveOpening(ID);

    expect(await deliverLiveOpening(ID, vi.fn())).toEqual({ delivered: false, reason: 'none_registered' });
  });

  it('drops an opening that was never asked for within its lifetime', async () => {
    vi.useFakeTimers();
    registerLiveOpening(ID, OPENING);
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(await deliverLiveOpening(ID, vi.fn())).toEqual({ delivered: false, reason: 'none_registered' });
  });
});

describe('deliverLiveOpeningViaSideband', () => {
  it('steers over the sideband and writes the record the browser used to log', async () => {
    registerLiveOpening(ID, OPENING);

    const result = await deliverLiveOpeningViaSideband(ID);

    expect(result).toMatchObject({ delivered: true, already: false });
    expect(sidebandMocks.tryInject).toHaveBeenCalledWith(ID, 'system', OPENING.text, true);
    expect(dbMocks.insertMessage).toHaveBeenCalledWith(ID, 'system', 'system', OPENING.logMessage, OPENING.logMessage, {
      source: 'live-opening',
    });
  });

  it('logs nothing when nothing was spoken', async () => {
    registerLiveOpening(ID, OPENING);
    sidebandMocks.tryInject.mockResolvedValue(false);

    expect(await deliverLiveOpeningViaSideband(ID)).toMatchObject({ delivered: false });
    expect(dbMocks.insertMessage).not.toHaveBeenCalled();
  });

  it('still reports delivery when only the log write fails', async () => {
    registerLiveOpening(ID, OPENING);
    dbMocks.insertMessage.mockRejectedValue(new Error('db down'));

    expect(await deliverLiveOpeningViaSideband(ID)).toMatchObject({ delivered: true });
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('scheduleLiveOpeningFallback', () => {
  it('speaks the opening itself when the browser never asks (a tab on a pre-lock bundle)', async () => {
    vi.useFakeTimers();
    registerLiveOpening(ID, OPENING);
    scheduleLiveOpeningFallback(ID, 10_000);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(sidebandMocks.tryInject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sidebandMocks.tryInject).toHaveBeenCalledTimes(1));
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('does nothing when the browser already asked', async () => {
    vi.useFakeTimers();
    registerLiveOpening(ID, OPENING);
    scheduleLiveOpeningFallback(ID, 10_000);
    await deliverLiveOpeningViaSideband(ID);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sidebandMocks.tryInject).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The opening watchdog (ai-therapist-315)
// ---------------------------------------------------------------------------
describe('opening watchdog (ai-therapist-315)', () => {
  const ORDINARY = { ...OPENING, via: 'commentary' as const, watch: true };
  let deps: {
    resend: ReturnType<typeof vi.fn>;
    onUnspoken: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
    onRetrigger: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    deps = {
      resend: vi.fn().mockResolvedValue(true),
      onUnspoken: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      onRetrigger: vi.fn(),
    };
    _setLiveOpeningWatchDepsForTests(deps as unknown as Partial<LiveOpeningWatchDeps>);
  });

  /** Register, then deliver as the browser's request does. */
  async function start(opening: Parameters<typeof registerLiveOpening>[1] = ORDINARY) {
    registerLiveOpening(ID, opening);
    const result = await deliverLiveOpeningViaSideband(ID);
    expect(result).toMatchObject({ delivered: true, already: false });
  }

  /** Every opening send: the delivery plus any re-trigger. */
  const sends = () => sidebandMocks.tryCommentary.mock.calls.length + deps.resend.mock.calls.length;

  it('delivers the ordinary opening as commentary, its exact registered text', async () => {
    await start();
    expect(sidebandMocks.tryCommentary).toHaveBeenCalledWith(ID, OPENING.text);
    expect(sidebandMocks.tryInject).not.toHaveBeenCalled();
  });

  it('a normal start produces exactly one opening and no signal', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_500);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sends()).toBe(1);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(_liveOpeningOutcomeForTests(ID)).toBe('spoken');
  });

  it('re-triggers once at the first bound, never before it', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS - 1);
    expect(deps.resend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.resend).toHaveBeenCalledTimes(1);
    expect(deps.resend).toHaveBeenCalledWith(ID, OPENING.text);
    expect(deps.onRetrigger).toHaveBeenCalledWith(ID, LIVE_OPENING_RETRIGGER_MS, true);
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining('LIVE OPENING SILENT'));
  });

  it('gives up at the second bound: one re-trigger, the unspoken signal, no loop', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_UNSPOKEN_MS - 1);
    expect(deps.onUnspoken).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
    expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining('LIVE OPENING UNSPOKEN'));

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.resend).toHaveBeenCalledTimes(1);
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
    expect(sends()).toBe(2);
    expect(_liveOpeningOutcomeForTests(ID)).toBe('unspoken');
    const detail = deps.record.mock.calls[0][1] as LiveOpeningTiming;
    expect(detail).toMatchObject({
      firstAudioMs: null,
      firstTranscriptMs: null,
      retriggerMs: LIVE_OPENING_RETRIGGER_MS,
      unspokenMs: LIVE_OPENING_UNSPOKEN_MS,
      watched: 1,
    });
  });

  it('an opening spoken after the give-up is still in the record (a late start, not a silent one)', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_UNSPOKEN_MS);
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
    expect(deps.record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record.mock.calls[0][1]).toMatchObject({
      firstAudioMs: LIVE_OPENING_UNSPOKEN_MS + 1_000,
      unspokenMs: LIVE_OPENING_UNSPOKEN_MS,
    });
    expect(_liveOpeningOutcomeForTests(ID)).toBe('unspoken');
    expect(deps.resend).toHaveBeenCalledTimes(1);
  });

  it('a close after the give-up records at once', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_UNSPOKEN_MS);
    clearLiveOpening(ID);
    expect(deps.record).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('the default instructions delivery is watched the same way; its one re-send is commentary', async () => {
    await start({ ...OPENING, via: 'instructions', watch: true });
    expect(sidebandMocks.tryInject).toHaveBeenCalledWith(ID, 'system', OPENING.text, true);
    expect(sidebandMocks.tryCommentary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_UNSPOKEN_MS);
    expect(deps.resend).toHaveBeenCalledTimes(1);
    expect(deps.resend).toHaveBeenCalledWith(ID, OPENING.text);
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
  });

  it('latches on the first assistant audio just before the first bound: nothing is re-sent', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS - 1);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
  });

  it('latches on a transcript as well as on audio', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(2_000);
    noteLiveOpeningAssistantSpeech(ID, 'transcript');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    // Audio not seen yet: the sideband keeps checking frames, for the record.
    expect(liveOpeningAwaitingSpeech(ID)).toBe(true);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    expect(liveOpeningAwaitingSpeech(ID)).toBe(false);
  });

  it('spoken after the re-trigger: no unspoken signal', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS + 900);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).toHaveBeenCalledTimes(1);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
  });

  it('a participant who speaks first and is answered gets no re-send and no signal', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    noteLiveOpeningParticipantSpeech(ID);
    await vi.advanceTimersByTimeAsync(2_500);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(_liveOpeningOutcomeForTests(ID)).toBe('participant_first');
    // The record keeps both: who was first, and when the assistant spoke.
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record.mock.calls[0][1] as LiveOpeningTiming).toMatchObject({
      participantFirstMs: 1_000,
      firstAudioMs: 3_500,
      retriggerMs: null,
      unspokenMs: null,
    });
  });

  it('an answer that comes after the first bound is still not re-sent over', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    noteLiveOpeningParticipantSpeech(ID);
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS + 1_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onRetrigger).not.toHaveBeenCalled();
    noteLiveOpeningAssistantSpeech(ID, 'transcript');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(_liveOpeningOutcomeForTests(ID)).toBe('participant_first');
  });

  // Measured 2026-11-26: the vendor transcribed "a purple" from a microphone
  // that sent only silence, 0.6 s after the opening request. Until then a
  // participant transcript ended the watch, so a silent start with one was
  // watched by nothing.
  it('a participant transcript does not excuse a start that never speaks: unspoken at the last bound', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(600);
    noteLiveOpeningParticipantSpeech(ID);
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_UNSPOKEN_MS - 700);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
    expect(deps.onUnspoken).toHaveBeenCalledWith(ID);
    expect(_liveOpeningOutcomeForTests(ID)).toBe('unspoken');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
    expect(deps.record.mock.calls[0][1] as LiveOpeningTiming).toMatchObject({
      participantFirstMs: 600,
      firstAudioMs: null,
      firstTranscriptMs: null,
      retriggerMs: null,
      unspokenMs: LIVE_OPENING_UNSPOKEN_MS,
    });
  });

  it('a participant transcript before the request: answered, nothing; never answered, unspoken', async () => {
    registerLiveOpening(ID, ORDINARY);
    noteLiveOpeningParticipantSpeech(ID);
    await deliverLiveOpeningViaSideband(ID);
    await vi.advanceTimersByTimeAsync(2_000);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(_liveOpeningOutcomeForTests(ID)).toBe('participant_first');

    const OTHER = `${ID}-never-answered`;
    registerLiveOpening(OTHER, ORDINARY);
    noteLiveOpeningParticipantSpeech(OTHER);
    await deliverLiveOpeningViaSideband(OTHER);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).toHaveBeenCalledTimes(1);
    expect(deps.onUnspoken).toHaveBeenCalledWith(OTHER);
  });

  it('a crisis signal after a participant transcript still takes priority over the last bound', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(600);
    noteLiveOpeningParticipantSpeech(ID);
    await vi.advanceTimersByTimeAsync(2_000);
    noteLiveOpeningCrisis(ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(_liveOpeningOutcomeForTests(ID)).toBe('crisis');
  });

  it('a recovery opening (measure-only) still settles at once on a participant transcript', async () => {
    await start({ ...OPENING, via: 'commentary' });
    await vi.advanceTimersByTimeAsync(500);
    noteLiveOpeningParticipantSpeech(ID);
    expect(_liveOpeningOutcomeForTests(ID)).toBe('participant_first');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('participant speech after the assistant began is not a barge-in before the opening', async () => {
    await start();
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    noteLiveOpeningParticipantSpeech(ID);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(_liveOpeningOutcomeForTests(ID)).toBe('spoken');
    expect((deps.record.mock.calls[0][1] as LiveOpeningTiming).participantFirstMs).toBeNull();
  });

  it('a crisis signal in the first seconds takes priority: nothing is re-sent or shown', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_200);
    noteLiveOpeningCrisis(ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(_liveOpeningOutcomeForTests(ID)).toBe('crisis');
  });

  it('a crisis signal before the request (a flagged check-in) also takes priority', async () => {
    registerLiveOpening(ID, ORDINARY);
    noteLiveOpeningCrisis(ID);
    await deliverLiveOpeningViaSideband(ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
  });

  it('a crisis after the re-trigger still stops the unspoken signal', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS + 500);
    noteLiveOpeningCrisis(ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
  });

  it('does not send the opening at all when the assistant is already speaking at the request', async () => {
    registerLiveOpening(ID, ORDINARY);
    // The startup developer message alone made it greet.
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    const result = await deliverLiveOpeningViaSideband(ID);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result).toMatchObject({ delivered: true, already: false });
    expect(sends()).toBe(0);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect((deps.record.mock.calls[0][1] as LiveOpeningTiming).firstAudioMs).toBeLessThanOrEqual(0);
  });

  it('a sideband that is down at the re-trigger (reconnect in the first seconds) does not loop or double', async () => {
    deps.resend.mockResolvedValue(false);
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS);
    expect(deps.onRetrigger).toHaveBeenCalledWith(ID, LIVE_OPENING_RETRIGGER_MS, false);
    // The reconnected sideband reports the opening being spoken.
    await vi.advanceTimersByTimeAsync(1_500);
    noteLiveOpeningAssistantSpeech(ID, 'transcript');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).toHaveBeenCalledTimes(1);
    expect(deps.onUnspoken).not.toHaveBeenCalled();
  });

  it('a second request after delivery neither re-sends nor re-arms', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS - 500);
    expect(await deliverLiveOpeningViaSideband(ID)).toMatchObject({ already: true });
    await vi.advanceTimersByTimeAsync(LIVE_OPENING_RETRIGGER_MS);
    expect(deps.resend).toHaveBeenCalledTimes(1);
  });

  it('never runs its timers on a recovery opening (it has its own re-send), but still records its timing', async () => {
    await start({ ...OPENING, via: 'commentary' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();

    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect((deps.record.mock.calls[0][1] as LiveOpeningTiming).watched).toBe(0);
  });

  it('records the timing once, numbers only, with audio and transcript', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(1_000);
    noteLiveOpeningAssistantSpeech(ID, 'audio');
    await vi.advanceTimersByTimeAsync(700);
    noteLiveOpeningAssistantSpeech(ID, 'transcript');
    await vi.advanceTimersByTimeAsync(10_000);
    clearLiveOpening(ID);

    expect(deps.record).toHaveBeenCalledTimes(1);
    const detail = deps.record.mock.calls[0][1] as LiveOpeningTiming;
    expect(detail).toEqual({
      requestAfterCreateMs: 0,
      firstAudioMs: 1_000,
      firstTranscriptMs: 1_700,
      participantFirstMs: null,
      crisisMs: null,
      retriggerMs: null,
      unspokenMs: null,
      watched: 1,
    });
    for (const v of Object.values(detail)) expect(v === null || typeof v === 'number').toBe(true);
  });

  it('a session that closes before anything was spoken is recorded and its timers stop', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(2_000);
    clearLiveOpening(ID);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('nothing is armed for an opening that was never delivered', async () => {
    registerLiveOpening(ID, ORDINARY);
    sidebandMocks.tryCommentary.mockResolvedValue(false);
    expect(await deliverLiveOpeningViaSideband(ID)).toMatchObject({ delivered: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.resend).not.toHaveBeenCalled();
    expect(deps.onUnspoken).not.toHaveBeenCalled();
  });
});
