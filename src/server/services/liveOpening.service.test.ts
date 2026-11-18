// Server-authored GPT-Live opening (ai-therapist-214). With the browser's data
// channel locked, this is the only way the AI disclosure preamble is spoken, so
// "delivered at most once, and retryable until it is" is the contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const sidebandMocks = vi.hoisted(() => ({ tryInject: vi.fn() }));
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
  _resetLiveOpeningsForTests,
} from './liveOpening.service.js';

const ID = 'live_test_1';
const OPENING = { text: "Say this phrase exactly: 'Hello!'", logMessage: 'Initial prompt: hello' };

beforeEach(() => {
  vi.clearAllMocks();
  _resetLiveOpeningsForTests();
  sidebandMocks.tryInject.mockResolvedValue(true);
  dbMocks.insertMessage.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deliverLiveOpening', () => {
  it('injects the registered text and reports the log line', async () => {
    registerLiveOpening(ID, OPENING);
    const inject = vi.fn().mockResolvedValue(true);

    const result = await deliverLiveOpening(ID, inject);

    expect(inject).toHaveBeenCalledWith(OPENING.text);
    expect(result).toEqual({ delivered: true, already: false, logMessage: OPENING.logMessage });
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
