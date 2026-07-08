import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../utils/logger.js";
import {
  ensureBucket,
  putObject,
  RECORDINGS_BUCKET,
} from "../config/objectStorage.js";
import { setSessionRecording } from "../db/recording.queries.js";

const log = createLogger("recorder");

// Live audio arrives as a single pre-mixed PCM16 stream (the participant's
// browser mixes mic + assistant before teeing). We append raw PCM bytes to a
// temp file as they arrive, then wrap them in a WAV container and upload to
// object storage when the session ends. Streaming to disk keeps memory flat
// even for long sessions (~170MB of PCM for 30 min would be too much for RAM).

interface ActiveRecording {
  filePath: string;
  stream: fs.WriteStream;
  sampleRate: number;
  byteLength: number;
  errored: boolean;
}

const recordings = new Map<string, ActiveRecording>();

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
// re-open the truncation window for long-lived zombie uploads.
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
): void {
  // Drop stragglers that arrive after the recording was closed — re-creating
  // the stream here would truncate the finalized file.
  if (finalized.has(sessionId)) return;

  let rec = recordings.get(sessionId);
  if (!rec) {
    const filePath = path.join(tmpDir(), `${sessionId}.pcm`);
    const stream = fs.createWriteStream(filePath);
    rec = { filePath, stream, sampleRate, byteLength: 0, errored: false };
    // A WriteStream with no 'error' listener throws (and can crash the process)
    // on a write failure. Capture it instead so we stop counting bytes that
    // never reached disk — otherwise the duration derived from the counter
    // would over-report the real audio.
    stream.on("error", (err) => {
      rec!.errored = true;
      log.error({ err }, `[rec] write stream error for ${sessionId}`);
    });
    recordings.set(sessionId, rec);
    log.info(`[rec] started recording for ${sessionId} @ ${sampleRate}Hz`);
  }
  if (rec.errored) return; // stream is dead; don't count bytes we can't persist
  const buf = Buffer.from(base64Pcm16, "base64");
  rec.stream.write(buf);
  rec.byteLength += buf.length;
}

/** Whether a session currently has buffered audio. */
export function hasRecording(sessionId: string): boolean {
  return recordings.has(sessionId);
}

/**
 * Close the buffer, wrap the PCM in a WAV header, upload to object storage and
 * persist the key on the session row. Never throws — recording is best-effort.
 */
export async function finalize(sessionId: string): Promise<void> {
  const rec = recordings.get(sessionId);
  if (!rec) return;
  recordings.delete(sessionId);
  // Block any straggler audio batches from re-opening this recording.
  markFinalized(sessionId);

  try {
    await new Promise<void>((resolve, reject) => {
      rec.stream.end((err?: unknown) => (err ? reject(err) : resolve()));
    });

    if (rec.byteLength === 0) {
      log.info(`[rec] ${sessionId} had no audio; skipping upload`);
      void cleanupTemp(rec.filePath);
      return;
    }

    const pcm = await fs.promises.readFile(rec.filePath);
    const wav = buildWav(pcm, rec.sampleRate);
    const key = `sessions/${sessionId}/recording.wav`;

    await ensureBucket();
    await putObject(key, wav, "audio/wav");

    // Derive duration from the bytes actually on disk, not the in-memory
    // counter — if any write was dropped the two diverge, and the stored
    // duration must reflect the real audio, not what we tried to write.
    if (pcm.length !== rec.byteLength) {
      log.warn(
        `[rec] ${sessionId} byte mismatch: counted ${rec.byteLength} but ` +
          `${pcm.length} on disk — reporting duration from disk`,
      );
    }
    const durationMs = Math.round((pcm.length / 2 / rec.sampleRate) * 1000);
    await setSessionRecording(sessionId, {
      objectKey: key,
      status: "ready",
      durationMs,
      sampleRate: rec.sampleRate,
      sizeBytes: wav.length,
    });

    log.info(
      `[rec] uploaded ${sessionId} → ${RECORDINGS_BUCKET}/${key} ` +
        `(${(wav.length / 1024 / 1024).toFixed(1)}MB, ${(durationMs / 1000).toFixed(0)}s)`,
    );
  } catch (err) {
    log.error({ err }, `[rec] failed to finalize recording for ${sessionId}`);
    try {
      await setSessionRecording(sessionId, { status: "failed" });
    } catch {
      /* swallow — best effort */
    }
  } finally {
    void cleanupTemp(rec.filePath);
  }
}

/** Discard a session's buffer without uploading (e.g. on hard failure). */
export function abort(sessionId: string): void {
  const rec = recordings.get(sessionId);
  if (!rec) return;
  recordings.delete(sessionId);
  markFinalized(sessionId);
  rec.stream.destroy();
  void cleanupTemp(rec.filePath);
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
