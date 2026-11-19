import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beaconRecordingTail,
  createAudioUploader,
  drainAndReport,
  DRAIN_TIMEOUT_MS,
  endAfterRecordingDrained,
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  requestTimeoutMs,
  type AudioUploader,
} from './audioUploader';

// The uploader is driven with fake timers against a fake server: each POST is
// "received" after a per-request delay, appended (in arrival order, like the
// real route) and answered. Every chunk carries its own index in its first
// samples, so the order the server appended them in is checked from the
// audio itself, independent of the `seq` field.

const SAMPLES = 4096; // one ScriptProcessor callback
const CHUNK_MS = 85; // 4096 samples at 48 kHz, rounded down

function chunk(i: number, samples = SAMPLES): string {
  const pcm = new Int16Array(samples);
  pcm[0] = i & 0x7fff;
  pcm[1] = i >> 15;
  return Buffer.from(pcm.buffer).toString('base64');
}
const CHUNK_LEN = chunk(0).length; // 10,924 base64 characters

function indexOf(b64: string): number {
  const pcm = new Int16Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
  return pcm[0] + (pcm[1] << 15);
}

type Outcome = number | 'network' | 'stored-then-network';

interface Body {
  chunks: string[];
  sampleRate: number;
  track: string;
  seq: number;
  muted?: number[];
}

function installServer(opts: { delayMs?: (n: number) => number; outcome?: (n: number) => Outcome } = {}) {
  const appended: Record<string, number[]> = { mixed: [], participant: [] };
  const bodies: Body[] = [];
  const sentAt: number[] = [];
  let n = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn((_url: string, init: { body: string; keepalive?: boolean }) => {
    const k = n++;
    const body = JSON.parse(init.body) as Body;
    bodies.push(body);
    sentAt.push(Date.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<{ status: number }>((resolve, reject) => {
      setTimeout(
        () => {
          inFlight -= 1;
          const outcome = opts.outcome?.(k) ?? 204;
          if (outcome === 'network') return reject(new TypeError('Load failed'));
          if (outcome === 'stored-then-network' || (outcome >= 200 && outcome < 300)) {
            appended[body.track].push(...body.chunks.map(indexOf));
          }
          if (outcome === 'stored-then-network') return reject(new TypeError('Load failed'));
          resolve({ status: outcome });
        },
        opts.delayMs?.(k) ?? 50,
      );
    });
  });
  const beacons: Body[] = [];
  const sendBeacon = vi.fn(() => false);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { sendBeacon });
  return {
    appended,
    bodies,
    sentAt,
    beacons,
    fetchMock,
    sendBeacon,
    maxInFlight: () => maxInFlight,
  };
}

async function feed(ups: AudioUploader[], from: number, count: number, muted?: (i: number) => boolean) {
  for (let i = from; i < from + count; i++) {
    for (const up of ups) up.push(chunk(i), 48000, muted?.(i) ?? false);
    await vi.advanceTimersByTimeAsync(CHUNK_MS);
  }
}

/** Await a promise while fake time moves on in 10 ms steps (drain needs the clock). */
async function run<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  void p.then((v) => {
    done = true;
    value = v;
  });
  while (!done) await vi.advanceTimersByTimeAsync(10);
  return value as T;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('session audio upload (ai-therapist-372)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never sends keepalive requests, so the 64 KiB keepalive budget cannot refuse a batch', async () => {
    const server = installServer();
    const mixed = createAudioUploader('s', 'mixed');
    const participant = createAudioUploader('s', 'participant');
    await feed([mixed, participant], 0, 350);
    await run(Promise.all([mixed.drain(), participant.drain()]));

    for (const call of server.fetchMock.mock.calls) {
      expect((call[1] as { keepalive?: boolean }).keepalive).toBeFalsy();
    }
    expect(server.appended.mixed).toEqual(range(0, 350));
    expect(server.appended.participant).toEqual(range(0, 350));
  });

  it('keeps chunks in order when an early response is slow: one request at a time', async () => {
    // The first request takes 2 s (a phone on cellular stalling), the rest
    // 50 ms. With several requests in flight the later ones would be appended
    // first.
    const server = installServer({ delayMs: (n) => (n === 0 ? 2000 : 50) });
    const up = createAudioUploader('s', 'participant');
    await feed([up], 0, 60);
    await run(up.drain());

    expect(server.maxInFlight()).toBe(1);
    expect(server.appended.participant).toEqual(range(0, 60));
  });

  it('coalesces audio that waited behind a stalled request into one larger batch, losing none', async () => {
    const server = installServer({ delayMs: (n) => (n === 0 ? 3000 : 50) });
    const up = createAudioUploader('s', 'mixed');
    await feed([up], 0, 50);
    await run(up.drain());

    // The first batch went out at the first tick; everything that arrived
    // during the 3 s stall went out together in the second request.
    expect(server.bodies[1].chunks.length).toBeGreaterThanOrEqual(30);
    expect(server.appended.mixed).toEqual(range(0, 50));
    expect(up.stats().chunksDropped).toBe(0);
  });

  it('caps a coalesced batch at maxBatchBytes and still delivers everything in order', async () => {
    const server = installServer({ delayMs: (n) => (n === 0 ? 3000 : 50) });
    const up = createAudioUploader('s', 'mixed', { maxBatchBytes: 4 * CHUNK_LEN });
    await feed([up], 0, 50);
    await run(up.drain());

    expect(Math.max(...server.bodies.map((b) => b.chunks.length))).toBe(4);
    expect(server.appended.mixed).toEqual(range(0, 50));
  });

  it('bounds the waiting audio and drops the OLDEST past the bound, counted', async () => {
    const bound = 10 * CHUNK_LEN;
    const server = installServer({ delayMs: (n) => (n === 0 ? 3000 : 50) });
    const up = createAudioUploader('s', 'participant', { maxPendingBytes: bound });
    await feed([up], 0, 50);
    const stats = await run(up.drain());

    expect(stats.maxPendingBytes).toBe(bound);
    const got = server.appended.participant;
    expect(stats.chunksDropped).toBe(50 - got.length);
    expect(stats.chunksDropped).toBeGreaterThan(0);
    // What survived is the first batch plus the newest chunks, in order.
    const firstBatch = server.bodies[0].chunks.length;
    expect(got.slice(0, firstBatch)).toEqual(range(0, firstBatch));
    expect(got.slice(firstBatch)).toEqual(range(50 - (got.length - firstBatch), 50));
    // The server sees the gap in the sequence numbers.
    expect(server.bodies[1].seq).toBe(50 - (got.length - firstBatch));
  });

  it('numbers chunks per track: seq is the index of the first chunk of each batch', async () => {
    const server = installServer();
    const up = createAudioUploader('s', 'participant');
    await feed([up], 0, 30);
    await run(up.drain());

    let expected = 0;
    for (const body of server.bodies) {
      expect(body.seq).toBe(expected);
      expected += body.chunks.length;
    }
    expect(expected).toBe(30);
  });

  it('retries a failed batch in place with a growing delay, then delivers it once', async () => {
    const server = installServer({ outcome: (n) => (n < 2 ? 'network' : 204) });
    const up = createAudioUploader('s', 'mixed');
    await feed([up], 0, 5); // first tick at 400 ms carries chunks 0..3
    await vi.advanceTimersByTimeAsync(3000);

    expect(server.sentAt[1] - server.sentAt[0]).toBeGreaterThanOrEqual(50 + RETRY_BASE_MS);
    expect(server.sentAt[2] - server.sentAt[1]).toBeGreaterThanOrEqual(50 + 2 * RETRY_BASE_MS);
    expect(server.bodies[0].seq).toBe(server.bodies[2].seq);
    const stats = await run(up.drain());
    expect(stats.retries).toBe(2);
    expect(stats.chunksLost).toBe(0);
    expect(server.appended.mixed).toEqual(range(0, 5));
  });

  it(`gives a batch up after ${MAX_ATTEMPTS} attempts, counts it lost, and goes on in order`, async () => {
    const server = installServer({ outcome: (n) => (n < MAX_ATTEMPTS ? 503 : 204) });
    const up = createAudioUploader('s', 'mixed');
    up.push(chunk(0), 48000);
    up.push(chunk(1), 48000);
    await vi.advanceTimersByTimeAsync(400 + 50 + RETRY_BASE_MS + 50 + 2 * RETRY_BASE_MS + 50);
    up.push(chunk(2), 48000);
    const stats = await run(up.drain());

    const attemptsOnFirst = server.bodies.filter((b) => b.seq === 0).length;
    expect(attemptsOnFirst).toBe(MAX_ATTEMPTS);
    expect(stats.batchesLost).toBe(1);
    expect(stats.chunksLost).toBe(2);
    expect(server.appended.mixed).toEqual([2]);
  });

  it('does not retry a request the server refused as malformed', async () => {
    const server = installServer({ outcome: () => 400 });
    const up = createAudioUploader('s', 'mixed');
    up.push(chunk(0), 48000);
    const stats = await run(up.drain());
    expect(server.fetchMock).toHaveBeenCalledTimes(1);
    expect(stats.chunksLost).toBe(1);
  });

  it('a retry after a lost response resends the same seq, so the server can drop the duplicate', async () => {
    const server = installServer({ outcome: (n) => (n === 0 ? 'stored-then-network' : 204) });
    const up = createAudioUploader('s', 'mixed');
    up.push(chunk(0), 48000);
    await run(up.drain());
    expect(server.bodies.map((b) => b.seq)).toEqual([0, 0]);
  });

  it('aborts a request that never answers and retries it, so one dead connection cannot hold the track', async () => {
    // The first request hangs forever (a dead connection after a cellular
    // hand-over) but honours its abort signal, as fetch does.
    const appended: number[] = [];
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init: { body: string; signal?: AbortSignal }) => {
      const k = calls++;
      const body = JSON.parse(init.body) as Body;
      return new Promise<{ status: number }>((resolve, reject) => {
        if (k === 0) {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          return;
        }
        setTimeout(() => {
          appended.push(...body.chunks.map(indexOf));
          resolve({ status: 204 });
        }, 50);
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });

    const up = createAudioUploader('s', 'participant', { requestTimeoutMs: () => 5_000 });
    await feed([up], 0, 120); // about 10 s of audio
    const stats = await run(up.drain(10_000));

    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(stats.retries).toBe(1);
    expect(stats.chunksUndelivered).toBe(0);
    expect(appended).toEqual(range(0, 120));
  });

  it('scales the request timeout with the body, so a slow but moving large batch is not cut', () => {
    expect(requestTimeoutMs(55_000)).toBeGreaterThanOrEqual(20_000);
    expect(requestTimeoutMs(6 * 1024 * 1024)).toBeGreaterThan(requestTimeoutMs(55_000) + 150_000);
  });

  it('stops for good once the server reports the recording closed (410), counted', async () => {
    const server = installServer({ outcome: () => 410 });
    const up = createAudioUploader('s', 'mixed');
    await feed([up], 0, 10);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.fetchMock).toHaveBeenCalledTimes(1);
    expect(up.stats().chunksAfterClose).toBeGreaterThan(0);
  });

  it('drain sends what is left at once and resolves when it has been answered', async () => {
    const server = installServer();
    const up = createAudioUploader('s', 'mixed');
    up.push(chunk(0), 48000);
    up.push(chunk(1), 48000);
    let done = false;
    void up.drain().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(49);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(server.appended.mixed).toEqual([0, 1]);
  });

  it(`drain gives up at ${DRAIN_TIMEOUT_MS} ms and counts what was not delivered`, async () => {
    installServer({ delayMs: () => 60_000 });
    const up = createAudioUploader('s', 'mixed');
    up.push(chunk(0), 48000);
    await vi.advanceTimersByTimeAsync(400); // first batch in flight, hanging
    up.push(chunk(1), 48000);
    let result: Awaited<ReturnType<AudioUploader['drain']>> | null = null;
    void up.drain().then((s) => (result = s));
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).not.toBeNull();
    expect(result!.chunksUndelivered).toBe(2);
  });

  it('drain does not wait out a retry delay', async () => {
    const server = installServer({ outcome: (n) => (n === 0 ? 'network' : 204) });
    const up = createAudioUploader('s', 'mixed');
    up.push(chunk(0), 48000);
    await vi.advanceTimersByTimeAsync(400 + 50); // failed; retry scheduled in 500 ms
    const start = Date.now();
    await run(up.drain());
    expect(Date.now() - start).toBeLessThan(RETRY_BASE_MS);
    expect(server.appended.mixed).toEqual([0]);
  });

  it('marks muted chunks and records the mic timeline in track time', async () => {
    const server = installServer();
    const up = createAudioUploader('s', 'participant');
    // Muted for chunks 0-9, on for 10-19, muted again for 20-24.
    await feed([up], 0, 25, (i) => i < 10 || i >= 20);
    await run(up.drain());

    const mutedIdx: number[] = [];
    for (const b of server.bodies) for (const m of b.muted ?? []) mutedIdx.push(b.seq + m);
    expect(mutedIdx).toEqual([...range(0, 10), ...range(20, 25)]);
    const ms = (n: number) => Math.round(((n * SAMPLES) / 48000) * 1000);
    expect(up.micTimeline()).toEqual({
      toggles: [
        [0, 0],
        [ms(10), 1],
        [ms(20), 0],
      ],
      truncated: false,
      mutedMs: ms(15),
      totalMs: ms(25),
    });
  });

  it('page hide beacons the unsent tail inside the budget, participant track first', async () => {
    const server = installServer({ delayMs: () => 60_000 });
    const accepted: Array<{ url: string; size: number }> = [];
    server.sendBeacon.mockImplementation(((url: string, blob: Blob) => {
      accepted.push({ url, size: blob.size });
      return true;
    }) as never);
    const mixed = createAudioUploader('s', 'mixed');
    const participant = createAudioUploader('s', 'participant');
    // 3 chunks each, none sent yet (no tick has fired).
    for (let i = 0; i < 3; i++) {
      mixed.push(chunk(i), 48000);
      participant.push(chunk(i), 48000);
    }
    // Room for about four chunks in all.
    const used = beaconRecordingTail({ mixed, participant }, 4 * CHUNK_LEN + 200);

    expect(participant.stats().chunksBeaconed).toBe(3);
    expect(mixed.stats().chunksBeaconed).toBe(1);
    expect(mixed.stats().chunksUndelivered).toBe(2);
    expect(used).toBe(accepted.reduce((n, a) => n + a.size, 0));
    expect(used).toBeLessThanOrEqual(4 * CHUNK_LEN + 200);
  });

  it('reports the counts (numbers only) and the mic timeline once at the end', async () => {
    installServer();
    const mixed = createAudioUploader('s', 'mixed');
    const participant = createAudioUploader('s', 'participant');
    await feed([mixed, participant], 0, 10);
    const report = vi.fn();
    await run(drainAndReport({ mixed, participant }, report));

    expect(report.mock.calls.map((c) => c[0])).toEqual(['audio_upload_summary', 'mic_timeline']);
    const summary = report.mock.calls[0][1] as Record<string, Record<string, unknown>>;
    expect(Object.keys(summary).sort()).toEqual(['mixed', 'participant']);
    for (const track of Object.values(summary)) {
      for (const v of Object.values(track)) expect(typeof v).toBe('number');
    }
    expect(summary.participant.sent).toBe(10);
  });
});

describe('the order of a voice-session end (ai-therapist-372)', () => {
  it('ends the session only after the logs are flushed and the recording has drained', async () => {
    const order: string[] = [];
    let release!: () => void;
    const drained = new Promise<void>((r) => (release = r)).then(() => {
      order.push('drained');
    });
    const ending = endAfterRecordingDrained({
      flushLogs: async () => {
        order.push('logs');
      },
      drained,
      end: async () => {
        order.push('end');
      },
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(['logs']); // POST /end waits for the drain
    release();
    await ending;
    expect(order).toEqual(['logs', 'drained', 'end']);
  });

  it('still ends the session when the log flush or the drain fails', async () => {
    const end = vi.fn(async () => {});
    await endAfterRecordingDrained({
      flushLogs: () => Promise.reject(new Error('offline')),
      drained: Promise.reject(new Error('drain failed')),
      end,
    });
    expect(end).toHaveBeenCalledOnce();
  });
});
