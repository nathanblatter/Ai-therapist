import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAudioUploader, drainAndReport, DRAIN_TIMEOUT_MS, endAfterRecordingDrained } from './audioUploader';
import { createSessionEndGate, END_JOIN_MAX_MS } from './sessionEnd';

// A second End press while the first one's recording drain is running
// (ai-therapist-384). The session end is rebuilt here the way App.tsx's
// stopSession() runs it: take the uploaders (a later call finds none), drain,
// then POST /end. The fake server is the real route's contract: it appends
// audio in arrival order and refuses it with 410 once /end has been received.

const SAMPLES = 4096;

function chunk(i: number): string {
  const pcm = new Int16Array(SAMPLES);
  pcm[0] = i;
  return Buffer.from(pcm.buffer).toString('base64');
}

function installServer(audioDelayMs: number | null) {
  const appended: number[] = [];
  let ended = false;
  let endCalls = 0;
  let refused = 0;
  vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: { body?: string }) => {
      if (url.endsWith('/end')) {
        endCalls += 1;
        ended = true;
        return Promise.resolve({ status: 200 });
      }
      const body = JSON.parse(init.body as string) as { chunks: string[] };
      // null: this request is never answered (a dead connection).
      if (audioDelayMs === null) return new Promise<{ status: number }>(() => {});
      return new Promise<{ status: number }>((resolve) => {
        setTimeout(() => {
          if (ended) {
            refused += body.chunks.length;
            return resolve({ status: 410 });
          }
          for (const c of body.chunks) {
            appended.push(new Int16Array(new Uint8Array(Buffer.from(c, 'base64')).buffer)[0]);
          }
          resolve({ status: 204 });
        }, audioDelayMs);
      });
    }),
  );
  return { appended, endCalls: () => endCalls, refused: () => refused };
}

/** One session whose End can be pressed any number of times. */
function session(gated: boolean) {
  let uploader: ReturnType<typeof createAudioUploader> | null = createAudioUploader('s', 'participant');
  const live = uploader;
  const gate = createSessionEndGate();
  const reports: Array<Record<string, unknown>> = [];

  // App.tsx stopRecordingCapture + the voice branch of stopSession.
  const teardown = async () => {
    const taken = uploader;
    uploader = null;
    const drained = taken
      ? drainAndReport({ mixed: null, participant: taken }, (kind, detail) => {
          if (kind === 'audio_upload_summary') reports.push(detail);
        })
      : Promise.resolve();
    await endAfterRecordingDrained({
      flushLogs: async () => {},
      drained,
      end: async () => {
        await fetch('/api/sessions/s/end', { method: 'POST' });
      },
    });
  };
  return {
    push: (i: number) => live.push(chunk(i), 48000),
    pressEnd: () => (gated ? gate.run('s', teardown) : teardown()),
    gate,
    reports,
  };
}

async function settle(p: Promise<unknown>) {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) await vi.advanceTimersByTimeAsync(10);
}

describe('a second End press while the session is finishing (ai-therapist-384)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('the defect: an ungated second teardown sends /end ahead of the drain and the tail is refused', async () => {
    const server = installServer(1000); // a phone on a slow link: each batch takes 1 s
    const s = session(false);
    for (let i = 0; i < 6; i++) s.push(i);
    const first = s.pressEnd();
    await vi.advanceTimersByTimeAsync(200);
    const second = s.pressEnd();
    await settle(Promise.all([first, second]));
    expect(server.appended).toEqual([]);
    expect(server.refused()).toBe(6);
    expect(server.endCalls()).toBe(2);
  });

  it('joins the running teardown: /end goes out once, after the last batch has landed', async () => {
    const server = installServer(1000);
    const s = session(true);
    for (let i = 0; i < 6; i++) s.push(i);
    const first = s.pressEnd();
    await vi.advanceTimersByTimeAsync(200);
    expect(s.gate.isEnding('s')).toBe(true);
    const second = s.pressEnd();
    const third = s.pressEnd();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await vi.advanceTimersByTimeAsync(500);
    expect(server.endCalls()).toBe(0); // still draining
    await settle(first);
    expect(server.appended).toEqual([0, 1, 2, 3, 4, 5]);
    expect(server.refused()).toBe(0);
    expect(server.endCalls()).toBe(1);
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({ participant: { sent: 6, afterClose: 0, undelivered: 0 } });
    expect(s.gate.isEnding('s')).toBe(false);
  });

  it('stays bounded: with a dead connection, presses do not extend the drain and /end still goes out', async () => {
    const server = installServer(null);
    const s = session(true);
    for (let i = 0; i < 6; i++) s.push(i);
    const first = s.pressEnd();
    for (let t = 500; t < DRAIN_TIMEOUT_MS; t += 500) {
      await vi.advanceTimersByTimeAsync(500);
      void s.pressEnd();
    }
    expect(server.endCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    await first;
    expect(server.endCalls()).toBe(1);
    // What the drain could not deliver is counted, not silently gone.
    expect(s.reports[0]).toMatchObject({ participant: { sent: 0, undelivered: 6 } });
  });
});

describe('the session end gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs again once the teardown has finished', async () => {
    const gate = createSessionEndGate();
    const teardown = vi.fn(async () => {});
    await gate.run('a', teardown);
    await gate.run('a', teardown);
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it('does not join the teardown of another session', async () => {
    const gate = createSessionEndGate();
    let release!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => (release = r)));
    const other = vi.fn(async () => {});
    const a = gate.run('a', first);
    await gate.run('b', other);
    await gate.run(null, other);
    expect(other).toHaveBeenCalledTimes(2);
    release();
    await a;
  });

  it(`stops absorbing presses after ${END_JOIN_MAX_MS} ms, so a hung teardown cannot make End a dead button`, async () => {
    const gate = createSessionEndGate();
    const hung = vi.fn(() => new Promise<void>(() => {}));
    void gate.run('a', hung);
    await vi.advanceTimersByTimeAsync(END_JOIN_MAX_MS - 1);
    void gate.run('a', hung);
    expect(hung).toHaveBeenCalledTimes(1);
    expect(gate.isEnding('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.isEnding('a')).toBe(false);
    const retry = vi.fn(async () => {});
    await gate.run('a', retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('a teardown that fails rejects every joined press and frees the gate', async () => {
    const gate = createSessionEndGate();
    const failing = () => {
      throw new Error('teardown failed');
    };
    const first = gate.run('a', failing);
    const second = gate.run('a', failing);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow('teardown failed');
    expect(gate.isEnding('a')).toBe(false);
  });

  it('a late finish of a superseded teardown does not free the newer one', async () => {
    const gate = createSessionEndGate(1000);
    let releaseOld!: () => void;
    void gate.run('a', () => new Promise<void>((r) => (releaseOld = r)));
    await vi.advanceTimersByTimeAsync(1000);
    const newer = vi.fn(() => new Promise<void>(() => {}));
    void gate.run('a', newer);
    releaseOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.isEnding('a')).toBe(true);
    void gate.run('a', newer);
    expect(newer).toHaveBeenCalledTimes(1);
  });
});
