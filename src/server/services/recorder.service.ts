import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../utils/logger.js";
import {
  ensureBucket,
  putObject,
  RECORDINGS_BUCKET,
} from "../config/objectStorage.js";
import {
  setSessionRecording,
  setSessionParticipantRecording,
} from "../db/recording.queries.js";

const log = createLogger("recorder");

// Live audio arrives as base64 PCM16 batches, tagged by track:
//   'mixed'       — the browser's mic+assistant mixdown (admin playback, 022)
//   'participant' — the pre-gain mic-only tap (prosody research, 086)
// Old clients and the redteam harness send untagged batches, which default to
// 'mixed'. We append raw PCM bytes to a per-(session, track) temp file as they
// arrive, then wrap each in a WAV container and upload when the session ends.
// Streaming to disk keeps memory flat even for long sessions (~170MB of PCM
// for 30 min would be too much for RAM).

export type RecordingTrack = "mixed" | "participant";
const TRACKS: RecordingTrack[] = ["mixed", "participant"];

interface ActiveRecording {
  filePath: string;
  stream: fs.WriteStream;
  sampleRate: number;
  byteLength: number;
  errored: boolean;
}

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

const TMP_DIR = path.join(os.tmpdir(), "ai-therapist-recordings");

function tmpDir(): string {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

/** Append a base64 PCM16 chunk to the session's on-disk recording buffer. */
export function appendChunk(
  sessionId: string,
  base64Pcm16: string,
  sampleRate: number,
  track: RecordingTrack = "mixed",
): void {
  // Drop stragglers that arrive after the recording was closed — re-creating
  // the stream here would truncate the finalized file.
  if (finalized.has(sessionId)) return;

  const key = recKey(sessionId, track);
  let rec = recordings.get(key);
  if (!rec) {
    const filePath = path.join(tmpDir(), `${sessionId}.${track}.pcm`);
    const stream = fs.createWriteStream(filePath);
    rec = { filePath, stream, sampleRate, byteLength: 0, errored: false };
    // A WriteStream with no 'error' listener throws (and can crash the process)
    // on a write failure. Capture it instead so we stop counting bytes that
    // never reached disk — otherwise the duration derived from the counter
    // would over-report the real audio.
    stream.on("error", (err) => {
      rec!.errored = true;
      log.error({ err }, `[rec] write stream error for ${key}`);
    });
    recordings.set(key, rec);
    log.info(`[rec] started ${track} recording for ${sessionId} @ ${sampleRate}Hz`);
  }
  if (rec.errored) return; // stream is dead; don't count bytes we can't persist
  const buf = Buffer.from(base64Pcm16, "base64");
  rec.stream.write(buf);
  rec.byteLength += buf.length;
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
  if (tracks.length === 0) return;
  for (const { track } of tracks) recordings.delete(recKey(sessionId, track));
  // Block any straggler audio batches from re-opening this recording.
  markFinalized(sessionId);

  for (const { track, rec } of tracks) {
    await finalizeTrack(sessionId, track, rec);
  }
}

async function finalizeTrack(
  sessionId: string,
  track: RecordingTrack,
  rec: ActiveRecording,
): Promise<void> {
  const persist = track === "mixed" ? setSessionRecording : setSessionParticipantRecording;
  const objectName = track === "mixed" ? "recording.wav" : "participant.wav";
  try {
    await new Promise<void>((resolve, reject) => {
      rec.stream.end((err?: unknown) => (err ? reject(err) : resolve()));
    });

    if (rec.byteLength === 0) {
      log.info(`[rec] ${sessionId} ${track} had no audio; skipping upload`);
      void cleanupTemp(rec.filePath);
      return;
    }

    const pcm = await fs.promises.readFile(rec.filePath);
    const wav = buildWav(pcm, rec.sampleRate);
    const key = `sessions/${sessionId}/${objectName}`;

    await ensureBucket();
    await putObject(key, wav, "audio/wav");

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
      status: "ready",
      durationMs,
      sampleRate: rec.sampleRate,
      sizeBytes: wav.length,
    });

    log.info(
      `[rec] uploaded ${sessionId} ${track} → ${RECORDINGS_BUCKET}/${key} ` +
        `(${(wav.length / 1024 / 1024).toFixed(1)}MB, ${(durationMs / 1000).toFixed(0)}s)`,
    );
  } catch (err) {
    log.error({ err }, `[rec] failed to finalize ${track} recording for ${sessionId}`);
    try {
      await persist(sessionId, { status: "failed" });
    } catch {
      /* swallow — best effort */
    }
  } finally {
    void cleanupTemp(rec.filePath);
  }
}

/** Discard a session's buffers without uploading (e.g. on hard failure). */
export function abort(sessionId: string): void {
  const tracks = TRACKS.map((track) => recordings.get(recKey(sessionId, track))).filter(
    (rec): rec is ActiveRecording => Boolean(rec),
  );
  if (tracks.length === 0) return;
  for (const track of TRACKS) recordings.delete(recKey(sessionId, track));
  markFinalized(sessionId);
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
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
