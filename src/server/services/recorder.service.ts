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
}

/** Per-chunk metadata from the client (ai-therapist-372, -384); all optional. */
export interface ChunkMeta {
  /** Per-track index of this chunk. */
  seq?: number;
  /** The participant's mic was muted for this chunk. */
  muted?: boolean;
  /** Chunks the client had captured on this track when it sent the batch (ai-therapist-384). */
  pushed?: number;
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
    };
    // A WriteStream with no 'error' listener throws (and can crash the process)
    // on a write failure. Capture it instead so we stop counting bytes that
    // never reached disk — otherwise the duration derived from the counter
    // would over-report the real audio.
    stream.on('error', (err) => {
      rec!.errored = true;
      log.error({ err }, `[rec] write stream error for ${key}`);
    });
    recordings.set(key, rec);
    log.info(`[rec] started ${track} recording for ${sessionId} @ ${sampleRate}Hz`);
  }
  if (meta.pushed !== undefined && (rec.clientPushed === null || meta.pushed > rec.clientPushed)) {
    rec.clientPushed = meta.pushed;
  }
  const missing = acceptSeq(sessionId, track, rec, meta.seq);
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
  if (samples > 0) rec.chunkSamples = samples;

  if (window) window.last = now;
  else arrivals.set(sessionId, { first: now, last: now });

  if (meta.muted) rec.mutedSamples += samples;
  else if (track === 'participant') {
    rec.unmutedSamples += samples;
    rec.unmutedSumSquares += pcm16SumSquares(buf);
  }
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
 * is also true for a moment after a participant unmutes and speaks. It must
 * never be used to drop or down-weight a participant turn.
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
  for (const { track } of tracks) recordings.delete(recKey(sessionId, track));

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
