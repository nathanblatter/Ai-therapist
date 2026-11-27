import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ensureBucket, putObject, RECORDINGS_BUCKET } from '../config/objectStorage.js';
import {
  setSessionRecording,
  setSessionParticipantRecording,
  flagParticipantAudioProblem,
} from '../db/recording.queries.js';
import {
  buildSidecar,
  recordingSidecarKey,
  TRACK_DATA_METADATA_KEY,
  type GapRange,
  type RecordingSidecar,
  type SampleRange,
  type TrackSidecar,
} from './recordingSidecar.js';

const log = createLogger('recorder');

// Live audio arrives as base64 PCM16 batches, tagged by track:
//   'mixed'       — the browser's mic+assistant mixdown (admin playback, 022)
//   'participant' — the pre-gain mic-only tap (prosody research, 086)
// Old clients and the redteam harness send untagged batches, which default to
// 'mixed'. We append raw PCM bytes to a per-(session, track) temp file as they
// arrive, then wrap each in a WAV container and upload when the session ends.
// Streaming to disk keeps memory flat even for long sessions (~170MB of PCM
// for 30 min would be too much for RAM).

export type RecordingTrack = 'mixed' | 'participant';
const TRACKS: RecordingTrack[] = ['mixed', 'participant'];

interface ActiveRecording {
  filePath: string;
  stream: fs.WriteStream;
  sampleRate: number;
  byteLength: number;
  errored: boolean;
  // Sequence check (ai-therapist-372): index of the next chunk expected from
  // the client, null until a batch carrying `seq` arrives (legacy clients and
  // the redteam harness send none).
  nextSeq: number | null;
  gapChunks: number;
  gapEvents: number;
  staleChunks: number;
  inStaleRun: boolean;
  // Level of the audio the participant did not mute, accumulated chunk by
  // chunk so finalize never scans a long track in one go.
  unmutedSamples: number;
  unmutedSumSquares: number;
  mutedSamples: number;
  // Sidecar bookkeeping (ai-therapist-384), in samples of this track's file.
  sequenced: boolean;
  // A batch without `seq` arrived (an older client); with `sequenced` too, the
  // app was updated mid-session and the timeline cannot be trusted.
  unsequenced: boolean;
  chunkSamples: number | null;
  chunksReceived: number;
  clientPushed: number | null;
  filledSamples: number;
  gapCount: number;
  gaps: GapRange[];
  gapsTruncated: boolean;
  timelineIntact: boolean;
  muted: SampleRange[];
  mutedTruncated: boolean;
  // Muted-turn check (ai-therapist-412). When the last chunk NOT marked muted
  // arrived (wall clock), null when none has; whether anything about the
  // track's delivery was ever out of the ordinary (a gap, a stale chunk, a
  // batch without `seq`, a write error); and the turns waiting for a verdict.
  lastUnmutedAt: number | null;
  irregular: boolean;
  waiters: Set<MutedTurnWaiter>;
  // When the last chunk marked muted that was NOT exact digital silence
  // arrived: the flag and the audio disagree, so neither is believed.
  lastMutedSignalAt: number | null;
  // When the last chunk was appended, and one mark per HTTP batch (the newest
  // MAX_BATCH_MARKS): what proves the microphone was being captured without a
  // pause across a turn (CONTINUOUS CAPTURE below).
  lastAppendAt: number | null;
  batchMarks: BatchMark[];
  // Chunks of different sizes arrived, so a chunk count is not a duration.
  unevenChunks: boolean;
}

/**
 * One HTTP batch of a track, for the continuity proof. The uploader keeps one
 * request in flight and cuts the next batch only after the previous one was
 * answered, and the server answers after appending. So the batch was sent at
 * some moment between `earliestSentAt` (the previous batch's last append) and
 * `arrivedAt`, both on this server's clock, and `pushed` is how many chunks
 * the browser had captured at that moment.
 */
interface BatchMark {
  /** Null for a track's first batch: nothing bounds when it was sent. */
  earliestSentAt: number | null;
  arrivedAt: number;
  /** Null when the batch did not say, or said less than an earlier batch. */
  pushed: number | null;
}

/** Batch marks kept per track: several minutes at the uploader's 400 ms batches. */
export const MAX_BATCH_MARKS = 1024;

/** Per-chunk metadata from the client (ai-therapist-372, -384); all optional. */
export interface ChunkMeta {
  /** Per-track index of this chunk. */
  seq?: number;
  /** The participant's mic was muted for this chunk. */
  muted?: boolean;
  /** Chunks the client had captured on this track when it sent the batch (ai-therapist-384). */
  pushed?: number;
  /** This chunk is the first of its HTTP batch (ai-therapist-412). */
  batchStart?: boolean;
}

/**
 * Lost audio is replaced by digital silence of exactly the missing length
 * (ai-therapist-384), so the track keeps the client's timeline. Caps keep a
 * bogus index from writing gigabytes: one fill is at most MAX_GAP_FILL_MS, and
 * a track's fills together at most the session's wall-clock span so far (first
 * audio arrival on either track to now) plus MAX_GAP_FILL_MS, the allowance
 * that lets a gap at the very start be filled. A capped fill is marked in the
 * sidecar, and the track's timeline is no longer intact after it.
 */
export const MAX_GAP_FILL_MS = 60_000;
/**
 * The caps are computed at most at this rate. The sample rate is the client's
 * own number (the first batch's `sampleRate`), so without this a bogus rate
 * scaled the caps: one batch at sampleRate 1e9 could ask for 120 GB of zeros
 * written synchronously. Browsers record at 44.1 or 48 kHz. The caps bound
 * bytes written, so above 96 kHz (the route accepts 176.4 and 192 kHz) the
 * per-fill cap is 30 s or less of audio time (60 s x 96000 samples), and a
 * longer gap there is a capped, marked fill: fine.
 */
export const MAX_FILL_SAMPLE_RATE = 96_000;
/** Ranges kept per list in the sidecar; counts and totals always cover all of them. */
export const MAX_SIDECAR_RANGES = 5_000;
/** Zero bytes are written in slices of this size. */
const ZERO_SLICE = Buffer.alloc(64 * 1024);

// First and last audio arrival per session, either track: the wall-clock
// stretch the browser was capturing, to judge a track against when both
// tracks lost audio alike.
const arrivals = new Map<string, { first: number; last: number }>();

const recordings = new Map<string, ActiveRecording>();
const recKey = (sessionId: string, track: RecordingTrack) => `${sessionId}:${track}`;

// Sessions whose recording has already been finalized/aborted. Audio arrives as
// async HTTP batches and finalize fires from several independent end paths
// (user /end, admin end, max-duration auto-terminate), so batches can keep
// landing long *after* the recording is closed — e.g. when auto-terminate ends
// a session the participant's broken socket never tells them about, and their
// mic keeps streaming. Without this guard, appendChunk would re-create a fresh
// WriteStream on the same path with the truncating "w" flag — blowing away the
// finalized file (the "2:57 duration, 55s of audio" bug). Sessions are
// one-shot, so the marker is permanent for the process lifetime: a bare
// session-id string per ended session is negligible memory, and any TTL would
// re-open the truncation window for long-lived zombie uploads. The set is
// per-SESSION (not per-track) so one finalize atomically closes both tracks.
const finalized = new Set<string>();

function markFinalized(sessionId: string): void {
  finalized.add(sessionId);
}

/** Whether a session's recording has already been finalized or aborted. */
export function isFinalized(sessionId: string): boolean {
  return finalized.has(sessionId);
}

const TMP_DIR = path.join(os.tmpdir(), 'ai-therapist-recordings');

function tmpDir(): string {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

/** Append a base64 PCM16 chunk to the session's on-disk recording buffer. */
export function appendChunk(
  sessionId: string,
  base64Pcm16: string,
  sampleRate: number,
  track: RecordingTrack = 'mixed',
  meta: ChunkMeta = {},
): void {
  // Drop stragglers that arrive after the recording was closed — re-creating
  // the stream here would truncate the finalized file.
  if (finalized.has(sessionId)) return;

  const key = recKey(sessionId, track);
  let rec = recordings.get(key);
  if (!rec) {
    const filePath = path.join(tmpDir(), `${sessionId}.${track}.pcm`);
    const stream = fs.createWriteStream(filePath);
    rec = {
      filePath,
      stream,
      sampleRate,
      byteLength: 0,
      errored: false,
      nextSeq: null,
      gapChunks: 0,
      gapEvents: 0,
      staleChunks: 0,
      inStaleRun: false,
      unmutedSamples: 0,
      unmutedSumSquares: 0,
      mutedSamples: 0,
      sequenced: false,
      unsequenced: false,
      chunkSamples: null,
      chunksReceived: 0,
      clientPushed: null,
      filledSamples: 0,
      gapCount: 0,
      gaps: [],
      gapsTruncated: false,
      timelineIntact: true,
      muted: [],
      mutedTruncated: false,
      lastUnmutedAt: null,
      irregular: false,
      waiters: new Set(),
      lastMutedSignalAt: null,
      lastAppendAt: null,
      batchMarks: [],
      unevenChunks: false,
    };
    // A WriteStream with no 'error' listener throws (and can crash the process)
    // on a write failure. Capture it instead so we stop counting bytes that
    // never reached disk — otherwise the duration derived from the counter
    // would over-report the real audio.
    stream.on('error', (err) => {
      rec!.errored = true;
      rec!.irregular = true;
      settleWaiters(rec!);
      log.error({ err }, `[rec] write stream error for ${key}`);
    });
    recordings.set(key, rec);
    log.info(`[rec] started ${track} recording for ${sessionId} @ ${sampleRate}Hz`);
  }
  if (meta.pushed !== undefined && (rec.clientPushed === null || meta.pushed > rec.clientPushed)) {
    rec.clientPushed = meta.pushed;
  }
  const missing = acceptSeq(sessionId, track, rec, meta.seq);
  // Anything but an in-order, sequenced chunk ends the muted-turn check for
  // this track for good: the account of the microphone is no longer complete.
  if (missing !== 0 || meta.seq === undefined || rec.errored) {
    rec.irregular = true;
    settleWaiters(rec);
  }
  if (missing === null) return;
  if (rec.errored) return; // stream is dead; don't count bytes we can't persist
  const buf = Buffer.from(base64Pcm16, 'base64');
  const samples = Math.floor(buf.length / 2);
  const now = Date.now();
  const window = arrivals.get(sessionId);
  if (missing > 0) {
    // Chunks are all one size from the browser (4096 samples); a gap at the
    // very start is sized by the first chunk that does arrive.
    fillGap(rec, missing, rec.chunkSamples ?? samples, 'sequence_gap', window ? now - window.first : 0);
  }
  if (meta.muted) noteMuted(rec, rec.byteLength / 2, samples);
  rec.stream.write(buf);
  rec.byteLength += buf.length;
  rec.chunksReceived += 1;
  if (samples > 0) {
    if (rec.chunkSamples !== null && rec.chunkSamples !== samples) rec.unevenChunks = true;
    rec.chunkSamples = samples;
  }
  let mark: BatchMark | null = null;
  if (meta.batchStart) {
    const last = rec.batchMarks[rec.batchMarks.length - 1];
    const valid = meta.pushed !== undefined && Number.isInteger(meta.pushed) && meta.pushed >= 0;
    const backwards = valid && last?.pushed != null && meta.pushed! < last.pushed;
    mark = { earliestSentAt: rec.lastAppendAt, arrivedAt: now, pushed: valid && !backwards ? meta.pushed! : null };
    rec.batchMarks.push(mark);
    if (rec.batchMarks.length > MAX_BATCH_MARKS) rec.batchMarks.shift();
  }
  rec.lastAppendAt = now;

  if (window) window.last = now;
  else arrivals.set(sessionId, { first: now, last: now });

  if (meta.muted) {
    rec.mutedSamples += samples;
    // A disabled microphone track reaches the tee as exact zeros (audioTee.ts
    // copies the samples as they are), and the flag is `track.enabled` read
    // on the main thread after the audio was captured. A chunk flagged muted
    // that holds anything else was captured while the microphone was live.
    if (track === 'participant' && !isDigitalSilence(buf)) rec.lastMutedSignalAt = now;
  } else if (track === 'participant') {
    rec.unmutedSamples += samples;
    rec.unmutedSumSquares += pcm16SumSquares(buf);
    rec.lastUnmutedAt = now;
  }
  if (rec.waiters.size > 0) {
    if (mark) noteBatchForWaiters(rec, mark);
    settleWaiters(rec);
  }
}

/** Whether every byte of a chunk is zero. */
export function isDigitalSilence(pcm: Buffer): boolean {
  for (let offset = 0; offset < pcm.length; offset += ZERO_SLICE.length) {
    const end = Math.min(pcm.length, offset + ZERO_SLICE.length);
    if (pcm.compare(ZERO_SLICE, 0, end - offset, offset, end) !== 0) return false;
  }
  return true;
}

/**
 * Write digital silence for `chunks` missing chunks of `chunkSamples` each,
 * within the caps (MAX_GAP_FILL_MS), and record the range for the sidecar.
 * `spanMs` is the session's wall-clock span so far.
 */
function fillGap(
  rec: ActiveRecording,
  chunks: number,
  chunkSamples: number,
  reason: GapRange['reason'],
  spanMs: number,
): void {
  const wanted = chunks * chunkSamples;
  const capRate =
    Number.isFinite(rec.sampleRate) && rec.sampleRate > 0 ? Math.min(rec.sampleRate, MAX_FILL_SAMPLE_RATE) : 0;
  const maxSingle = Math.floor((MAX_GAP_FILL_MS * capRate) / 1000);
  const maxTotal = Math.floor(((Math.max(0, spanMs) + MAX_GAP_FILL_MS) * capRate) / 1000);
  const fill = Math.max(0, Math.min(wanted, maxSingle, maxTotal - rec.filledSamples));
  const start = rec.byteLength / 2;
  let bytes = fill * 2;
  while (bytes > 0) {
    const n = Math.min(bytes, ZERO_SLICE.length);
    rec.stream.write(ZERO_SLICE.subarray(0, n));
    bytes -= n;
  }
  rec.byteLength += fill * 2;
  rec.filledSamples += fill;
  rec.gapCount += 1;
  const capped = fill < wanted;
  if (capped) rec.timelineIntact = false;
  if (rec.gaps.length < MAX_SIDECAR_RANGES) {
    rec.gaps.push({ start, length: fill, chunks, reason, ...(capped ? { capped: true, missingSamples: wanted } : {}) });
  } else {
    rec.gapsTruncated = true;
  }
}

/** Extend the open muted range or start a new one at `start` (samples). */
function noteMuted(rec: ActiveRecording, start: number, samples: number): void {
  const last = rec.muted[rec.muted.length - 1];
  if (last && last.start + last.length === start) {
    last.length += samples;
  } else if (rec.muted.length < MAX_SIDECAR_RANGES) {
    rec.muted.push({ start, length: samples });
  } else {
    rec.mutedTruncated = true;
  }
}

/**
 * Check a chunk's sequence index against the one expected (ai-therapist-372).
 * The client sends one request at a time per track, so chunks arrive in
 * order; anything else is logged so a regression is visible. A gap (chunks
 * the client dropped or lost) is logged and the chunk appended. A stale chunk
 * (an index already passed: a retry of a batch the server had in fact stored,
 * or an out-of-order arrival) is logged and NOT appended: appending it would
 * put audio in the wrong place, and the server never reorders. One log line
 * per gap and per run of stale chunks. Returns null to drop the chunk, else
 * the number of chunks missing before it (filled with silence by the caller,
 * ai-therapist-384). A gap at the very start (first index above 0) counts too.
 */
function acceptSeq(
  sessionId: string,
  track: RecordingTrack,
  rec: ActiveRecording,
  seq: number | undefined,
): number | null {
  if (seq === undefined) {
    rec.unsequenced = true;
    return 0;
  }
  rec.sequenced = true;
  if (rec.nextSeq !== null && seq < rec.nextSeq) {
    rec.staleChunks += 1;
    if (!rec.inStaleRun) {
      rec.inStaleRun = true;
      log.warn(
        { sessionId, track, seq, expected: rec.nextSeq },
        `[rec] ${sessionId} ${track} out-of-order or duplicate audio chunk dropped`,
      );
    }
    return null;
  }
  rec.inStaleRun = false;
  const expected = rec.nextSeq ?? 0;
  let missing = 0;
  if (seq > expected) {
    missing = seq - expected;
    rec.gapChunks += missing;
    rec.gapEvents += 1;
    log.warn({ sessionId, track, seq, expected, missing }, `[rec] ${sessionId} ${track} audio sequence gap`);
  }
  rec.nextSeq = seq + 1;
  return missing;
}

/**
 * The sample rate a track's recording was opened at (its first batch), or null
 * when the track has no open recording. The audio route refuses a batch at
 * another rate: appending it would play at the wrong speed.
 */
export function trackSampleRate(sessionId: string, track: RecordingTrack): number | null {
  return recordings.get(recKey(sessionId, track))?.sampleRate ?? null;
}

/**
 * What this server has received of the participant's own microphone track so
 * far, numbers only: audio received, how much of it the browser marked muted
 * (the mic button disables the track, which sends exact zeros), how much it
 * did not, and the level of that unmuted audio.
 */
export interface ParticipantMicEvidence {
  received_ms: number;
  muted_ms: number;
  unmuted_ms: number;
  /** Level of the unmuted audio in dBFS, one decimal; null when there is none or it is exact silence. */
  unmuted_rms_dbfs: number | null;
}

/**
 * The participant track's audio as received up to now, or null when the
 * session has no open participant track here (recording off or not consented,
 * the harness, nothing uploaded yet, already finalised).
 *
 * EVIDENCE, NOT A LIVE MUTE STATE. The track arrives over batched HTTP behind
 * the microphone (400 ms batches, coalesced and retried for many seconds on a
 * poor connection, sometimes lost), and it is the browser's own account. So
 * `unmuted_ms: 0` means "no unmuted audio had REACHED the server yet", which
 * is also true for a moment after a participant unmutes and speaks. On its own
 * it must never be used to drop or down-weight a participant turn; the only
 * verdict is watchForMutedTurn's, which waits for the track to catch up.
 */
export function participantMicEvidence(sessionId: string): ParticipantMicEvidence | null {
  const rec = recordings.get(recKey(sessionId, 'participant'));
  if (!rec || !Number.isFinite(rec.sampleRate) || rec.sampleRate <= 0) return null;
  const toMs = (samples: number) => Math.round((samples / rec.sampleRate) * 1000);
  const level = rmsDbfs(rec.unmutedSumSquares, rec.unmutedSamples);
  return {
    received_ms: toMs(rec.byteLength / 2),
    muted_ms: toMs(rec.mutedSamples),
    unmuted_ms: toMs(rec.unmutedSamples),
    unmuted_rms_dbfs: Number.isFinite(level) ? Math.round(level * 10) / 10 : null,
  };
}

/**
 * MUTED-TURN CHECK (ai-therapist-412). The voice vendor sometimes produces a
 * participant transcript out of a muted microphone (exact zeros). This is the
 * one place that may say so, and it says so only on positive, complete
 * evidence; every other outcome means "treat the turn as real speech".
 *
 * `no_speech` requires ALL of:
 *
 * 1. A participant track is open, every chunk of it so far arrived in order
 *    with a sequence index, and nothing was lost, repeated or failed to write
 *    (`irregular` is false). One gap or one retried batch, ever, and the
 *    session gets no verdict again: lost chunks may have been speech.
 * 2. No chunk the browser did NOT mark muted has arrived since
 *    MUTED_TURN_WINDOW_MS before the turn started. Arrival is never earlier
 *    than capture, so unmuted audio captured in that window cannot have
 *    arrived before it.
 * 3. Every chunk marked muted since then really is digital silence. The flag
 *    is `track.enabled` read on the main thread after the audio was captured;
 *    a disabled track reaches the tee as exact zeros. A chunk flagged muted
 *    that holds anything but zeros was captured with the microphone live.
 * 4. The track has been received past the moment the check started, proven
 *    without comparing clocks: the uploader keeps one request in flight and
 *    cuts the next batch only after the previous one is answered, and the
 *    server answers after appending. So the SECOND batch appended after the
 *    check started was sent after it started, and its `pushed` (chunks
 *    captured when it was sent) covers everything captured up to then. The
 *    verdict waits until every chunk up to that index, plus
 *    MUTED_TURN_TAIL_MS more, has arrived, all of it marked muted.
 * 5. CONTINUOUS CAPTURE: the track covers the whole turn. Rules 1 to 4 only
 *    describe the audio that was captured. The tee runs in an AudioContext
 *    that can sit suspended while WebRTC already carries the live microphone
 *    to the vendor (a recovery session before the first tap; a tab put in the
 *    background), and a participant can speak then and mute afterwards: every
 *    chunk ever captured is muted, and the words were real. So the check also
 *    needs proof that the browser was capturing from before the turn started
 *    until after it closed, with no pause:
 *    - a batch J (not the track's first) that had ARRIVED by
 *      MUTED_TURN_LEAD_MS before the turn started, and
 *    - a batch K sent after the check started (as in rule 4), such that
 *    - the audio captured between them (`pushed` of K minus `pushed` of J,
 *      as a duration) is no less than the longest the wall clock allows
 *      between the two sends (K's arrival minus the append before J), less
 *      MUTED_TURN_CONTINUITY_TOLERANCE_MS.
 *    Each batch was sent between the previous batch's last append and its own
 *    arrival, so that is a bound on real elapsed time, on this server's clock
 *    alone. A context suspended for longer than the tolerance captures less
 *    audio than the clock ran, and no pair of batches can satisfy it. A track
 *    that started after the turn did has no batch J at all.
 *
 * If that has not happened within the timeout, or the recording closes, the
 * answer is `unknown`. Unmuted audio arriving at any point answers `speech`
 * at once, so a real turn whose audio was merely late is held only until its
 * first unmuted chunk lands.
 *
 * Known limits:
 * - A batch the browser gave up on (its last attempt aborted) that still
 *   reaches the server later, in order, breaks the causal chain in (4) and
 *   (5) without a stale chunk to show for it. The tail margin and the window
 *   in (2) are there for that; it would additionally need the whole utterance
 *   to fall after the covered index.
 * - A pause shorter than the tolerance in (5) cannot be told from upload
 *   latency and the uploader's 400 ms batch timer.
 * - A turn in the first seconds of a session (before two batches had arrived
 *   MUTED_TURN_LEAD_MS ahead of it) never gets a verdict.
 */
export type MutedTurnVerdict = 'no_speech' | 'speech' | 'unknown';

export interface MutedTurnResult {
  verdict: MutedTurnVerdict;
  /** The track as received when the verdict was reached; null when it had closed. */
  evidence: ParticipantMicEvidence | null;
}

/** How long a turn waits for its verdict before it is treated as real speech. */
export const MUTED_TURN_TIMEOUT_MS = 5_000;
/** Audio that must arrive, all muted, beyond the index proven to be after the check began. */
export const MUTED_TURN_TAIL_MS = 1_000;
/**
 * Unmuted microphone audio (or a muted-flagged chunk that is not silence)
 * arriving at any time from this long before a participant turn started means
 * no `no_speech` verdict. A participant who spoke and then muted within this
 * window simply gets none.
 */
export const MUTED_TURN_WINDOW_MS = 120_000;
/**
 * The track must be proven captured from at least this long before the turn
 * started. The start is this server's estimate from the vendor's transcript
 * events, which arrive after the words; this is the margin for that delay.
 */
export const MUTED_TURN_LEAD_MS = 5_000;
/**
 * Slack allowed between captured audio and the wall clock across a turn: the
 * uploader's 400 ms batch timer, upload latency and one chunk of rounding.
 */
export const MUTED_TURN_CONTINUITY_TOLERANCE_MS = 750;
/** Captured audio may exceed the wall-clock bound by one chunk of rounding plus this; more is a clock step. */
const CLOCK_SLOP_MS = 100;

interface MutedTurnWaiter {
  sessionId: string;
  since: number;
  /**
   * Continuity reference (rule 5): the largest "earliest send time minus
   * audio captured by then" over the batches that had arrived early enough.
   */
  reference: number;
  /** Whether capture has been proven continuous up to a batch sent after the check began. */
  continuous: boolean;
  /** Batches appended in order since the check began. */
  batches: number;
  /** Chunk index the track must reach; null until the second batch names it. */
  target: number | null;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: MutedTurnResult) => void;
}

function finishWaiter(rec: ActiveRecording, waiter: MutedTurnWaiter, verdict: MutedTurnVerdict, open = true): void {
  if (!rec.waiters.delete(waiter)) return;
  clearTimeout(waiter.timer);
  let evidence: ParticipantMicEvidence | null = null;
  try {
    evidence = open ? participantMicEvidence(waiter.sessionId) : null;
  } catch {
    evidence = null;
  }
  waiter.resolve({ verdict, evidence });
}

/** Duration of `chunks` chunks of this track, in ms. */
function chunksMs(rec: ActiveRecording, chunks: number): number {
  return ((chunks * (rec.chunkSamples ?? 0)) / rec.sampleRate) * 1000;
}

/**
 * The continuity reference for a turn (rule 5), or null when no batch proves
 * the track was being captured by `coveredFrom`. Only batches sent no earlier
 * than `since` count, so rule 2 covers every chunk captured after them.
 */
function continuityReference(rec: ActiveRecording, since: number, coveredFrom: number): number | null {
  let best: number | null = null;
  for (const mark of rec.batchMarks) {
    if (mark.earliestSentAt === null || mark.pushed === null) continue;
    if (mark.earliestSentAt < since || mark.arrivedAt > coveredFrom) continue;
    const offset = mark.earliestSentAt - chunksMs(rec, mark.pushed);
    if (best === null || offset > best) best = offset;
  }
  return best;
}

/** A batch's first chunk was appended in order: count it for every waiting turn. */
function noteBatchForWaiters(rec: ActiveRecording, mark: BatchMark): void {
  for (const waiter of [...rec.waiters]) {
    waiter.batches += 1;
    // The first batch after the check began may have been sent before it.
    if (waiter.batches < 2) continue;
    const chunkSamples = rec.chunkSamples ?? 0;
    if (mark.pushed === null || chunkSamples <= 0 || rec.unevenChunks) {
      finishWaiter(rec, waiter, 'unknown');
      continue;
    }
    if (waiter.target === null) {
      const tailChunks = Math.ceil((MUTED_TURN_TAIL_MS / 1000) * (rec.sampleRate / chunkSamples));
      waiter.target = Math.max(mark.pushed, rec.nextSeq ?? 0) + Math.max(1, tailChunks);
    }
    if (waiter.continuous) continue;
    // Wall clock the two sends can be apart at most, minus the audio captured
    // between them: what a pause in capture would leave behind.
    const shortfall = mark.arrivedAt - chunksMs(rec, mark.pushed) - waiter.reference;
    if (shortfall < -(chunksMs(rec, 1) + CLOCK_SLOP_MS)) {
      // More audio than time: this server's clock stepped, or the counts are
      // wrong. Either way nothing is proven.
      finishWaiter(rec, waiter, 'unknown');
    } else if (shortfall <= MUTED_TURN_CONTINUITY_TOLERANCE_MS) {
      waiter.continuous = true;
    }
  }
}

/** Answer every waiting turn that can be answered now. */
function settleWaiters(rec: ActiveRecording): void {
  for (const waiter of [...rec.waiters]) {
    if (rec.irregular || rec.errored || rec.unevenChunks) finishWaiter(rec, waiter, 'unknown');
    else if (rec.lastUnmutedAt !== null && rec.lastUnmutedAt >= waiter.since) finishWaiter(rec, waiter, 'speech');
    else if (rec.lastMutedSignalAt !== null && rec.lastMutedSignalAt >= waiter.since) {
      finishWaiter(rec, waiter, 'unknown');
    } else if (waiter.continuous && waiter.target !== null && rec.nextSeq !== null && rec.nextSeq >= waiter.target) {
      finishWaiter(rec, waiter, 'no_speech');
    }
  }
}

/** The recording is closing: every waiting turn is treated as real speech. */
function closeWaiters(rec: ActiveRecording): void {
  for (const waiter of [...rec.waiters]) finishWaiter(rec, waiter, 'unknown', false);
}

/**
 * Start a muted-turn check for a participant turn that has just closed.
 * `turnStartedAt` is the wall-clock time the turn's words began, as well as
 * this server can tell (never later than its first transcript fragment).
 *
 * Returns null when the turn cannot be judged a muted-microphone phantom on
 * what is known right now (no participant track, an irregular one, unmuted
 * audio inside the window, a muted-flagged chunk that was not silence, or no
 * proof the track was being captured before the turn started): the caller
 * carries on exactly as it would without this check. Otherwise a promise that
 * never rejects (see MUTED-TURN CHECK above).
 */
export function watchForMutedTurn(
  sessionId: string,
  turnStartedAt: number,
  timeoutMs: number = MUTED_TURN_TIMEOUT_MS,
): Promise<MutedTurnResult> | null {
  const rec = recordings.get(recKey(sessionId, 'participant'));
  if (!rec || rec.irregular || rec.errored) return null;
  if (!rec.sequenced || rec.unsequenced || rec.nextSeq === null) return null;
  if (!Number.isFinite(rec.sampleRate) || rec.sampleRate <= 0) return null;
  if (!rec.chunkSamples || rec.unevenChunks) return null;
  if (!Number.isFinite(turnStartedAt)) return null;
  const since = turnStartedAt - MUTED_TURN_WINDOW_MS;
  if (rec.lastUnmutedAt !== null && rec.lastUnmutedAt >= since) return null;
  if (rec.lastMutedSignalAt !== null && rec.lastMutedSignalAt >= since) return null;
  const reference = continuityReference(rec, since, turnStartedAt - MUTED_TURN_LEAD_MS);
  if (reference === null) return null;
  return new Promise<MutedTurnResult>((resolve) => {
    const waiter: MutedTurnWaiter = {
      sessionId,
      since,
      reference,
      continuous: false,
      batches: 0,
      target: null,
      timer: setTimeout(() => finishWaiter(rec, waiter, 'unknown'), Math.max(0, timeoutMs)),
      resolve,
    };
    waiter.timer.unref?.();
    rec.waiters.add(waiter);
  });
}

/** Whether a session currently has buffered audio on any track. */
export function hasRecording(sessionId: string): boolean {
  return TRACKS.some((track) => recordings.has(recKey(sessionId, track)));
}

/**
 * Close the buffers, wrap each track's PCM in a WAV header, upload to object
 * storage and persist the keys on the session row. Never throws — recording is
 * best-effort, and a participant-track failure never marks the mix failed.
 */
export async function finalize(sessionId: string): Promise<void> {
  const tracks = TRACKS.map((track) => ({
    track,
    rec: recordings.get(recKey(sessionId, track)),
  })).filter((t): t is { track: RecordingTrack; rec: ActiveRecording } => Boolean(t.rec));
  // Mark finalized FIRST, before the empty-tracks early return. The session has
  // ended either way, so returning early without the marker re-opened the
  // post-finalize write window: a straggler audio batch for a session that had
  // nothing buffered yet would start a fresh recording that nothing would ever
  // finalize.
  markFinalized(sessionId);
  if (tracks.length === 0) return;
  for (const { track, rec } of tracks) {
    recordings.delete(recKey(sessionId, track));
    closeWaiters(rec);
  }

  const window = arrivals.get(sessionId);
  arrivals.delete(sessionId);
  const wallMs = window ? window.last - window.first : 0;

  const ended: Array<{ track: RecordingTrack; rec: ActiveRecording; endError: unknown; totalSamples: number }> = [];
  for (const { track, rec } of tracks) {
    // A tail lost at the end (the drain timed out, the page went away): the
    // client reported more chunks captured than the server received after
    // the last one. Filled like any gap so the track keeps its full length.
    const tail = rec.nextSeq !== null && rec.clientPushed !== null ? rec.clientPushed - rec.nextSeq : 0;
    if (tail > 0 && !rec.errored && rec.chunkSamples) {
      rec.gapChunks += tail;
      rec.gapEvents += 1;
      log.warn({ sessionId, track, missing: tail }, `[rec] ${sessionId} ${track} audio tail missing`);
      fillGap(rec, tail, rec.chunkSamples, 'lost_tail', wallMs);
      rec.nextSeq = rec.clientPushed;
    }
    if (rec.gapChunks > 0 || rec.staleChunks > 0) {
      log.warn(
        { sessionId, track, gapChunks: rec.gapChunks, gapEvents: rec.gapEvents, staleChunks: rec.staleChunks },
        `[rec] ${sessionId} ${track} audio arrived with sequence problems`,
      );
    }
    // Close the buffer and measure it, so the sidecar can be stored BEFORE
    // the WAVs it describes (review of #105).
    let endError: unknown = null;
    let totalSamples = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        rec.stream.end((err?: unknown) => (err ? reject(err) : resolve()));
      });
      totalSamples = Math.floor((await fs.promises.stat(rec.filePath)).size / 2);
    } catch (err) {
      endError = err ?? new Error('write stream failed');
    }
    ended.push({ track, rec, endError, totalSamples });
  }

  // The sidecar first, then the WAVs: inserted zeros look exactly like a muted
  // mic, so a WAV must never sit there without a record of which it is. Each
  // WAV carries in its object metadata whether the sidecar was stored, so a
  // failed sidecar is told apart from a recording made before sidecars
  // existed (TRACK_DATA_METADATA_KEY; read by the admin recording-info route).
  const sidecarTracks: RecordingSidecar['tracks'] = {};
  for (const { track, rec, endError, totalSamples } of ended) {
    if (!endError && totalSamples > 0) sidecarTracks[track] = trackSidecar(track, rec, totalSamples);
  }
  const trackData = (await storeSidecar(sessionId, sidecarTracks)) ? 'stored' : 'missing';

  const results: Partial<Record<RecordingTrack, StoredTrack | null>> = {};
  for (const { track, rec, endError } of ended) {
    results[track] = await finalizeTrack(sessionId, track, rec, endError, trackData);
  }
  await checkParticipantTrack(sessionId, results, wallMs);
}

/** Sidecar upload attempts, and the backoff step between them. */
export const SIDECAR_ATTEMPTS = 3;
const SIDECAR_RETRY_STEP_MS = 200;

/**
 * Upload the sidecar (recordingSidecar.ts), describing the tracks about to be
 * stored, with a bounded retry. Returns whether it was stored. A failure never
 * marks a track failed (the audio is kept), but it is logged as an error and
 * recorded on each WAV (TRACK_DATA_METADATA_KEY = 'missing').
 */
async function storeSidecar(sessionId: string, tracks: RecordingSidecar['tracks']): Promise<boolean> {
  if (!tracks.mixed && !tracks.participant) return false;
  const body = Buffer.from(JSON.stringify(buildSidecar(tracks)));
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= SIDECAR_ATTEMPTS; attempt++) {
    try {
      await ensureBucket();
      await putObject(recordingSidecarKey(sessionId), body, 'application/json');
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < SIDECAR_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, SIDECAR_RETRY_STEP_MS * attempt));
      }
    }
  }
  log.error(
    { err: lastErr, sessionId, attempts: SIDECAR_ATTEMPTS },
    `[rec] recording sidecar NOT stored for ${sessionId}: inserted silence in its WAVs cannot be told ` +
      `from a muted microphone; the WAVs are marked ${TRACK_DATA_METADATA_KEY}=missing`,
  );
  return false;
}

function trackSidecar(track: RecordingTrack, rec: ActiveRecording, totalSamples: number): TrackSidecar {
  const missing = rec.gapChunks;
  return {
    object: track === 'mixed' ? 'recording.wav' : 'participant.wav',
    sampleRate: rec.sampleRate,
    totalSamples,
    sequenced: rec.sequenced && rec.unsequenced ? 'partial' : rec.sequenced,
    chunkSamples: rec.chunkSamples,
    chunksReceived: rec.chunksReceived,
    chunksStale: rec.staleChunks,
    chunksMissing: missing,
    clientChunksPushed: rec.clientPushed,
    insertedSilenceSamples: rec.filledSamples,
    gapCount: rec.gapCount,
    gaps: rec.gaps,
    gapsTruncated: rec.gapsTruncated,
    muted: rec.muted,
    mutedSamples: rec.mutedSamples,
    mutedTruncated: rec.mutedTruncated,
    timelineIntact: rec.sequenced && !rec.unsequenced && rec.timelineIntact,
    // Stale chunks are not a loss: a duplicate was already stored, and a late
    // chunk's place was already filled and counted as missing. Unknown when
    // any batch came without `seq` (its losses cannot be seen).
    complete: rec.sequenced && !rec.unsequenced ? missing === 0 && !rec.errored : null,
  };
}

/** What finalizeTrack stored for one track; null when nothing was stored. */
export interface StoredTrack {
  /** Length of the stored WAV, inserted silence included. */
  durationMs: number;
  /** Silence inserted for lost audio (ai-therapist-384). */
  insertedSilenceMs: number;
  /** Audio the participant had NOT muted (all of it for the mix and for legacy clients). */
  unmutedMs: number;
  /** Level of that unmuted audio. */
  unmutedRmsDbfs: number;
  gapChunks: number;
  staleChunks: number;
}

/**
 * A voice session long enough to judge must also have a usable participant
 * track: prosody research reads participant.wav, so one that is missing, cut
 * short or silent is a data-quality problem, and it used to be stored as
 * 'ready' with nothing said (ai-therapist-372: 0.17 s of participant audio
 * beside a 140 s mix).
 *
 * - The expected length is the longer of the mix and the wall-clock stretch
 *   audio was arriving (first to last batch): both tracks come from the same
 *   audio callback in the browser, but both can lose audio alike, and then
 *   only the clock shows it.
 * - The mic is OFF by default and a participant may stay muted or only type.
 *   A muted mic yields exact zeros, which is a choice, not a failure: the
 *   client marks muted chunks, and only audio recorded while the mic was on
 *   is judged for silence, and only once there is enough of it.
 * - Silence inserted for lost audio (ai-therapist-384) keeps the track's
 *   timeline but is not participant audio, so the length judged is the
 *   track's length without it.
 */
export const PARTICIPANT_CHECK_MIN_MIX_MS = 10_000;
export const PARTICIPANT_MIN_LENGTH_RATIO = 0.8;
export const PARTICIPANT_SILENT_DBFS = -60;
export const PARTICIPANT_MIN_UNMUTED_MS = 5_000;

export type ParticipantAudioProblem = 'missing' | 'short' | 'silent';

export function assessParticipantTrack(
  mixed: Pick<StoredTrack, 'durationMs'> | null | undefined,
  participant:
    | (Pick<StoredTrack, 'durationMs' | 'unmutedMs' | 'unmutedRmsDbfs'> &
        Partial<Pick<StoredTrack, 'insertedSilenceMs'>>)
    | null
    | undefined,
  wallMs = 0,
): ParticipantAudioProblem | null {
  const expectedMs = Math.max(mixed?.durationMs ?? 0, wallMs);
  if (!mixed || expectedMs < PARTICIPANT_CHECK_MIN_MIX_MS) return null;
  if (!participant) return 'missing';
  const receivedMs = participant.durationMs - (participant.insertedSilenceMs ?? 0);
  if (receivedMs < expectedMs * PARTICIPANT_MIN_LENGTH_RATIO) return 'short';
  if (participant.unmutedMs >= PARTICIPANT_MIN_UNMUTED_MS && participant.unmutedRmsDbfs < PARTICIPANT_SILENT_DBFS) {
    return 'silent';
  }
  return null;
}

/**
 * Whether a session without usable participant audio also gets an automatic
 * technical_failure row in protocol_deviations. OFF unless
 * system_config.features.participant_audio_auto_deviation is true: that table
 * feeds the IRB packet and its auto rows cannot be deleted, so the study owner
 * decides. The warning log line is written either way.
 */
async function autoDeviationEnabled(): Promise<boolean> {
  try {
    const { getSystemConfig } = await import('../utils/sessionHelpers.js');
    const features = ((await getSystemConfig()).features ?? {}) as Record<string, unknown>;
    return features.participant_audio_auto_deviation === true;
  } catch {
    return false;
  }
}

async function checkParticipantTrack(
  sessionId: string,
  results: Partial<Record<RecordingTrack, StoredTrack | null>>,
  wallMs: number,
): Promise<void> {
  const mixed = results.mixed;
  const participant = results.participant;
  const problem = assessParticipantTrack(mixed, participant, wallMs);
  if (!problem || !mixed) return;
  const round1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const details = {
    problem,
    mixedMs: mixed.durationMs,
    wallMs,
    participantMs: participant?.durationMs ?? 0,
    participantUnmutedMs: participant?.unmutedMs ?? 0,
    participantRmsDbfs: participant ? round1(participant.unmutedRmsDbfs) : null,
    participantGapChunks: participant?.gapChunks ?? 0,
    participantInsertedSilenceMs: participant?.insertedSilenceMs ?? 0,
  };
  log.warn(details, `[rec] ${sessionId} ended without usable participant audio (${problem})`);
  if (!(await autoDeviationEnabled())) return;
  try {
    await flagParticipantAudioProblem(sessionId, details);
  } catch (err) {
    log.error({ err }, `[rec] could not flag the participant-audio problem for ${sessionId}`);
  }
}

/** Sum of squared normalised samples of little-endian PCM16 (one chunk: cheap). */
export function pcm16SumSquares(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sumSquares += v * v;
  }
  return sumSquares;
}

function rmsDbfs(sumSquares: number, samples: number): number {
  if (samples <= 0) return -Infinity;
  const rms = Math.sqrt(sumSquares / samples);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Whole-signal RMS of little-endian PCM16, in dBFS (-Infinity for digital silence). */
export function pcm16RmsDbfs(pcm: Buffer): number {
  return rmsDbfs(pcm16SumSquares(pcm), Math.floor(pcm.length / 2));
}

async function finalizeTrack(
  sessionId: string,
  track: RecordingTrack,
  rec: ActiveRecording,
  endError: unknown,
  trackData: 'stored' | 'missing',
): Promise<StoredTrack | null> {
  const persist = track === 'mixed' ? setSessionRecording : setSessionParticipantRecording;
  const objectName = track === 'mixed' ? 'recording.wav' : 'participant.wav';
  try {
    // The buffer was closed by finalize() (before the sidecar was stored).
    if (endError) throw endError;

    if (rec.byteLength === 0) {
      log.info(`[rec] ${sessionId} ${track} had no audio; skipping upload`);
      void cleanupTemp(rec.filePath);
      return null;
    }

    const pcm = await fs.promises.readFile(rec.filePath);
    const wav = buildWav(pcm, rec.sampleRate);
    const key = `sessions/${sessionId}/${objectName}`;

    await ensureBucket();
    await putObject(key, wav, 'audio/wav', { [TRACK_DATA_METADATA_KEY]: trackData });

    // Derive duration from the bytes actually on disk, not the in-memory
    // counter — if any write was dropped the two diverge, and the stored
    // duration must reflect the real audio, not what we tried to write.
    if (pcm.length !== rec.byteLength) {
      log.warn(
        `[rec] ${sessionId} ${track} byte mismatch: counted ${rec.byteLength} but ` +
          `${pcm.length} on disk — reporting duration from disk`,
      );
    }
    const durationMs = Math.round((pcm.length / 2 / rec.sampleRate) * 1000);
    await persist(sessionId, {
      objectKey: key,
      status: 'ready',
      durationMs,
      sampleRate: rec.sampleRate,
      sizeBytes: wav.length,
    });

    log.info(
      `[rec] uploaded ${sessionId} ${track} → ${RECORDINGS_BUCKET}/${key} ` +
        `(${(wav.length / 1024 / 1024).toFixed(1)}MB, ${(durationMs / 1000).toFixed(0)}s)`,
    );
    // The level was accumulated chunk by chunk as the audio arrived (never a
    // scan of the whole track here). The mix is not judged for level.
    const unmutedMs = track === 'participant' ? Math.round((rec.unmutedSamples / rec.sampleRate) * 1000) : durationMs;
    const unmutedRmsDbfs = track === 'participant' ? rmsDbfs(rec.unmutedSumSquares, rec.unmutedSamples) : 0;
    const insertedSilenceMs = Math.round((rec.filledSamples / rec.sampleRate) * 1000);
    return {
      durationMs,
      insertedSilenceMs,
      unmutedMs,
      unmutedRmsDbfs,
      gapChunks: rec.gapChunks,
      staleChunks: rec.staleChunks,
    };
  } catch (err) {
    log.error({ err }, `[rec] failed to finalize ${track} recording for ${sessionId}`);
    try {
      await persist(sessionId, { status: 'failed' });
    } catch {
      /* swallow — best effort */
    }
    return null;
  } finally {
    void cleanupTemp(rec.filePath);
  }
}

/** Discard a session's buffers without uploading (e.g. on hard failure). */
export function abort(sessionId: string): void {
  const tracks = TRACKS.map((track) => recordings.get(recKey(sessionId, track))).filter((rec): rec is ActiveRecording =>
    Boolean(rec),
  );
  // Same ordering fix as finalize(): the marker must be set even when nothing
  // was buffered, or a straggler batch re-opens a recording for an aborted
  // session.
  markFinalized(sessionId);
  arrivals.delete(sessionId);
  if (tracks.length === 0) return;
  for (const track of TRACKS) recordings.delete(recKey(sessionId, track));
  for (const rec of tracks) {
    closeWaiters(rec);
    rec.stream.destroy();
    void cleanupTemp(rec.filePath);
  }
}

async function cleanupTemp(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    /* already gone */
  }
}

/** Build a minimal mono PCM16 WAV file from raw little-endian PCM bytes. */
function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
