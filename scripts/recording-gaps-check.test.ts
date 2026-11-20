// End-to-end check of lost-audio handling (ai-therapist-384): the REAL browser
// uploader (src/client/main/lib/audioUploader.ts, bundled with esbuild) runs in
// headless Chromium and posts to a local stub server that feeds the REAL
// recorder (src/server/services/recorder.service.ts) the way the audio route
// does. The stub injects permanent failures (every attempt at a batch refused)
// and a stalled connection; afterwards the stored PCM is read back and checked
// sample by sample against the recording sidecar.
//
// No network beyond 127.0.0.1, no database, no object storage: putObject is
// replaced by an in-memory map and the recorder's temp files go to a private
// directory. Not part of `npm test` (it needs the Chromium build):
//
//   npx playwright install chromium-headless-shell   # once
//   npx vitest run --config scripts/recording-gaps-check.config.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-gaps-check-'));
process.env.TMPDIR = tmp; // the recorder's temp PCM files land here

const { stored } = vi.hoisted(() => ({ stored: new Map<string, { body: Buffer; type: string }>() }));
vi.mock('../src/server/config/objectStorage.js', () => ({
  RECORDINGS_BUCKET: 'local-check',
  ensureBucket: async () => {},
  putObject: async (key: string, body: Buffer, type: string) => {
    stored.set(key, { body, type });
  },
  getObjectStream: async () => {
    throw new Error('not used');
  },
}));
vi.mock('../src/server/db/recording.queries.js', () => ({
  setSessionRecording: async () => {},
  setSessionParticipantRecording: async () => {},
  flagParticipantAudioProblem: async () => false,
}));
vi.mock('../src/server/utils/sessionHelpers.js', () => ({ getSystemConfig: async () => ({ features: {} }) }));

const { appendChunk, finalize } = await import('../src/server/services/recorder.service.js');

const SAMPLES = 4096;
const RATE = 48000;

type Track = 'mixed' | 'participant';
interface AudioBody {
  chunks: string[];
  sampleRate: number;
  track: Track;
  seq?: number;
  muted?: number[];
  pushed?: number;
}

/** Per session: which requests the stub refuses or holds. */
interface Plan {
  /** Refuse (503) every attempt at a batch containing one of these chunk indexes. */
  refuse?: Partial<Record<Track, number[]>>;
  /** Never answer the first request containing a chunk at or after this index (a stalled connection). */
  holdFrom?: Partial<Record<Track, number>>;
  holding?: Set<Track>;
}
const plans = new Map<string, Plan>();
const held: http.ServerResponse[] = [];
let appendedBatches = 0;

function handleAudio(sessionId: string, body: AudioBody, res: http.ServerResponse) {
  const plan = plans.get(sessionId) ?? {};
  const first = body.seq ?? 0;
  const indexes = body.chunks.map((_, i) => first + i);
  if (indexes.some((i) => plan.refuse?.[body.track]?.includes(i))) {
    res.writeHead(503).end();
    return;
  }
  const holdFrom = plan.holdFrom?.[body.track];
  plan.holding ??= new Set();
  if (holdFrom !== undefined && !plan.holding.has(body.track) && indexes.some((i) => i >= holdFrom)) {
    plan.holding.add(body.track);
    held.push(res);
    return;
  }
  // As the route does (sessions.routes.ts): one appendChunk per chunk.
  const muted = new Set(body.muted ?? []);
  body.chunks.forEach((pcm, i) => {
    appendChunk(sessionId, pcm, body.sampleRate, body.track, {
      seq: body.seq === undefined ? undefined : body.seq + i,
      muted: muted.has(i),
      ...(body.pushed === undefined ? {} : { pushed: body.pushed }),
    });
  });
  appendedBatches += 1;
  res.writeHead(204).end();
}

let server: http.Server;
let base = '';
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createAudioUploader, beaconRecordingTail } from './src/client/main/lib/audioUploader';
        window.__app = { createAudioUploader, beaconRecordingTail };
      `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
  });
  const code = bundle.outputFiles[0].text;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><title>recording gaps check</title><script>window.__name = (f) => f;</script><script>${code}</script>`,
      );
      return;
    }
    const m = /^\/api\/sessions\/([^/]+)\/audio$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) {
      res.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => handleAudio(m[1], JSON.parse(Buffer.concat(parts).toString('utf8')) as AudioBody, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`${base}/`);
}, 60_000);

afterAll(async () => {
  for (const res of held) res.destroy();
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface DriveOpts {
  sessionId: string;
  chunks: number;
  mutedFrom?: number;
  mutedTo?: number;
  /** End by page hide (beacon with this budget) instead of a drain. */
  beaconBudget?: number;
}

/** Feed both tracks in lockstep from the page, like startMixedTee does, then drain or beacon. */
async function drive(opts: DriveOpts) {
  return page.evaluate(
    async ({ sessionId, chunks, samples, rate, mutedFrom, mutedTo, beaconBudget }) => {
      type Up = {
        push: (pcm: string, sr: number, muted?: boolean) => void;
        drain: (t?: number) => Promise<Record<string, number>>;
        stats: () => Record<string, number>;
      };
      const app = (window as unknown as { __app: Record<string, (...a: unknown[]) => unknown> }).__app;
      const options = { flushMs: 40, retryBaseMs: 20 };
      const mixed = app.createAudioUploader(sessionId, 'mixed', options) as Up;
      const participant = app.createAudioUploader(sessionId, 'participant', options) as Up;
      const chunkOf = (i: number) => {
        const pcm = new Int16Array(samples).fill(i + 1); // every sample says which chunk it is
        let bin = '';
        const bytes = new Uint8Array(pcm.buffer);
        for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
        return btoa(bin);
      };
      for (let i = 0; i < chunks; i++) {
        const pcm = chunkOf(i);
        mixed.push(pcm, rate);
        participant.push(pcm, rate, i >= (mutedFrom ?? -1) && i < (mutedTo ?? -1));
        await new Promise((r) => setTimeout(r, 4));
      }
      if (beaconBudget !== undefined) {
        app.beaconRecordingTail({ mixed, participant }, beaconBudget);
        return { mixed: mixed.stats(), participant: participant.stats() };
      }
      const [m, p] = await Promise.all([mixed.drain(5000), participant.drain(5000)]);
      return { mixed: m, participant: p };
    },
    { ...opts, samples: SAMPLES, rate: RATE },
  );
}

function pcmOf(sessionId: string, name: string): Int16Array {
  const obj = stored.get(`sessions/${sessionId}/${name}`);
  if (!obj) throw new Error(`no ${name}`);
  const data = obj.body.subarray(44);
  return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
}

/** One value per chunk slot: the chunk index + 1 where audio landed, 0 for inserted silence. */
function slots(pcm: Int16Array): number[] {
  expect(pcm.length % SAMPLES).toBe(0);
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += SAMPLES) {
    const slot = pcm.subarray(i, i + SAMPLES);
    expect(new Set(slot).size).toBe(1);
    out.push(slot[0]);
  }
  return out;
}

type Gap = { start: number; length: number; reason: string };
function sidecarOf(sessionId: string) {
  const obj = stored.get(`sessions/${sessionId}/recording-tracks.json`);
  if (!obj) throw new Error('no sidecar');
  return JSON.parse(obj.body.toString('utf8'));
}

/** Every slot is either its own chunk or silence inside a recorded gap, and every gap is silence. */
function expectTruthful(values: number[], gaps: Gap[]) {
  const inGap = (slot: number) => gaps.some((g) => slot * SAMPLES >= g.start && slot * SAMPLES < g.start + g.length);
  values.forEach((v, slot) => {
    if (inGap(slot)) expect(v).toBe(0);
    else expect(v).toBe(slot + 1);
  });
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('lost audio in a real browser upload (ai-therapist-384)', () => {
  it('fills permanent failures at the start and in the middle; both tracks stay sample-aligned', async () => {
    const sessionId = 'live_gapcheck_drain';
    plans.set(sessionId, { refuse: { participant: [0, 60], mixed: [120] } });
    const stats = await drive({ sessionId, chunks: 200, mutedFrom: 80, mutedTo: 100 });
    await finalize(sessionId);

    expect(stats.participant.batchesLost).toBe(2);
    expect(stats.mixed.batchesLost).toBe(1);
    const sc = sidecarOf(sessionId);
    const p = sc.tracks.participant;
    const m = sc.tracks.mixed;
    const pv = slots(pcmOf(sessionId, 'participant.wav'));
    const mv = slots(pcmOf(sessionId, 'recording.wav'));

    // Full length on both tracks: nothing shortened.
    expect(pv).toHaveLength(200);
    expect(mv).toHaveLength(200);
    expect(p.totalSamples).toBe(200 * SAMPLES);
    // Every lost chunk is silence at its own place and listed; every other slot is its own chunk.
    expectTruthful(pv, p.gaps);
    expectTruthful(mv, m.gaps);
    expect(p.gaps[0].start).toBe(0); // the gap at the very start
    expect(p.chunksMissing).toBe(stats.participant.chunksLost);
    expect(m.chunksMissing).toBe(stats.mixed.chunksLost);
    expect(p.insertedSilenceSamples).toBe(stats.participant.chunksLost * SAMPLES);
    // Sample-aligned: where both tracks have audio, it is the same chunk.
    pv.forEach((v, i) => {
      if (v !== 0 && mv[i] !== 0) expect(v).toBe(mv[i]);
    });
    expect(sc.tracksAligned).toBe(true);
    // Muted range from the per-chunk flags, in WAV samples.
    expect(p.muted).toEqual([{ start: 80 * SAMPLES, length: 20 * SAMPLES }]);
    expect(p.complete).toBe(false);
  }, 60_000);

  it('a stalled connection and a page hide: the beaconed tail lands in place, the rest is filled to the captured length', async () => {
    const sessionId = 'live_gapcheck_hide';
    plans.set(sessionId, { holdFrom: { participant: 100, mixed: 100 } });
    const before = appendedBatches;
    // Room for about 5 chunks in all, inside the browser's 64 KiB beacon quota: the participant track first.
    const stats = await drive({ sessionId, chunks: 150, beaconBudget: 5 * 10_924 + 400 });
    expect(stats.participant.chunksBeaconed).toBe(5);
    await waitFor(() => appendedBatches > before && stats.participant.chunksBeaconed > 0);
    await new Promise((r) => setTimeout(r, 300)); // let the beacons land
    await finalize(sessionId);

    const sc = sidecarOf(sessionId);
    const p = sc.tracks.participant;
    const pv = slots(pcmOf(sessionId, 'participant.wav'));
    expect(p.clientChunksPushed).toBe(150);
    expect(pv).toHaveLength(150); // filled to what the client captured
    expectTruthful(pv, p.gaps);
    expect(p.gaps.at(-1).reason).toBe('lost_tail');
    expect(p.chunksReceived).toBe(150 - p.chunksMissing);
    // The mix had no beacon budget left: its tail is unknown, but what it holds is still in place.
    const m = sc.tracks.mixed;
    const mv = slots(pcmOf(sessionId, 'recording.wav'));
    expect(mv.length).toBeLessThanOrEqual(150);
    expectTruthful(mv, m.gaps);
  }, 60_000);
});
