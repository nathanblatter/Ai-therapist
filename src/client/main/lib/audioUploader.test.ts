import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAudioUploader } from './audioUploader';

// A browser's keepalive budget (Fetch standard "inflight keepalive bytes"):
// the bodies of all keepalive requests in flight together may not exceed
// 64 KiB; the request that would go over is rejected with a TypeError. WebKit
// and Chromium both enforce it, and sendBeacon draws on the same budget.
const KEEPALIVE_BUDGET = 64 * 1024;
const RESPONSE_MS = 150; // the request is in flight this long

// One ScriptProcessor callback: 4096 PCM16 samples, base64 (10,924 chars).
const CHUNK = Buffer.from(new Int16Array(4096).fill(300).buffer).toString('base64');
const CHUNK_MS_48K = (4096 / 48000) * 1000;

interface Delivered {
  track: string;
  chunks: number;
}

function installBrowser(opts: { beaconAccepts?: boolean } = {}) {
  const delivered: Delivered[] = [];
  const beacons: Delivered[] = [];
  let inflightKeepalive = 0;

  const fetchMock = vi.fn((_url: string, init: { body: string; keepalive?: boolean }) => {
    const size = init.body.length;
    if (init.keepalive) {
      if (inflightKeepalive + size > KEEPALIVE_BUDGET) return Promise.reject(new TypeError('Load failed'));
      inflightKeepalive += size;
    }
    return new Promise<{ status: number }>((resolve) => {
      setTimeout(() => {
        if (init.keepalive) inflightKeepalive -= size;
        const parsed = JSON.parse(init.body) as { track: string; chunks: string[] };
        delivered.push({ track: parsed.track, chunks: parsed.chunks.length });
        resolve({ status: 204 });
      }, RESPONSE_MS);
    });
  });
  const sendBeacon = vi.fn((_url: string, blob: Blob) => {
    if (!opts.beaconAccepts) return false;
    beacons.push({ track: 'beacon', chunks: blob.size });
    return true;
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { sendBeacon });
  return { delivered, beacons, fetchMock, sendBeacon };
}

const sum = (rows: Delivered[], track: string) =>
  rows.filter((r) => r.track === track).reduce((n, r) => n + r.chunks, 0);

describe('session audio upload keeps both tracks (ai-therapist-372)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delivers every participant chunk alongside the mix at 48 kHz', async () => {
    const browser = installBrowser();
    const mixed = createAudioUploader('s1');
    const participant = createAudioUploader('s1', 400, 'participant');

    // 30 s of audio: both taps fire on the same audio-context callback.
    const callbacks = Math.floor(30_000 / CHUNK_MS_48K);
    for (let i = 0; i < callbacks; i++) {
      mixed.push(CHUNK, 48000);
      participant.push(CHUNK, 48000);
      await vi.advanceTimersByTimeAsync(CHUNK_MS_48K);
    }
    mixed.stop();
    participant.stop();
    await vi.advanceTimersByTimeAsync(RESPONSE_MS * 2);

    expect(sum(browser.delivered, 'mixed')).toBe(callbacks);
    expect(sum(browser.delivered, 'participant')).toBe(callbacks);
  });

  it('never streams batches as keepalive requests', async () => {
    const browser = installBrowser();
    const up = createAudioUploader('s2', 400, 'participant');
    up.push(CHUNK, 48000);
    await vi.advanceTimersByTimeAsync(400);
    expect(browser.fetchMock).toHaveBeenCalledTimes(1);
    const init = browser.fetchMock.mock.calls[0][1] as { keepalive?: boolean };
    expect(init.keepalive).toBeFalsy();
    up.stop();
  });

  it('falls back to a plain request when the final beacon is refused', async () => {
    const browser = installBrowser({ beaconAccepts: false });
    const up = createAudioUploader('s3', 400, 'participant');
    for (let i = 0; i < 4; i++) up.push(CHUNK, 48000);
    up.stop();
    await vi.advanceTimersByTimeAsync(RESPONSE_MS);

    expect(browser.sendBeacon).toHaveBeenCalledTimes(1);
    expect(sum(browser.delivered, 'participant')).toBe(4);
  });

  it('uses the beacon alone when the browser accepts it', async () => {
    const browser = installBrowser({ beaconAccepts: true });
    const up = createAudioUploader('s4');
    up.push(CHUNK, 48000);
    up.stop();
    await vi.advanceTimersByTimeAsync(RESPONSE_MS);

    expect(browser.sendBeacon).toHaveBeenCalledTimes(1);
    expect(browser.fetchMock).not.toHaveBeenCalled();
  });

  it('stops uploading once the server reports the recording closed', async () => {
    const browser = installBrowser();
    browser.fetchMock.mockImplementation(() => Promise.resolve({ status: 410 }));
    const up = createAudioUploader('s5');
    up.push(CHUNK, 48000);
    await vi.advanceTimersByTimeAsync(400);
    up.push(CHUNK, 48000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(browser.fetchMock).toHaveBeenCalledTimes(1);
  });
});
