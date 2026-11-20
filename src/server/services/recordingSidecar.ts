// The recording sidecar (ai-therapist-384): one small JSON object stored next
// to a session's WAVs, at sessions/<id>/recording-tracks.json, describing what
// each WAV contains. Numbers only: no transcript, no audio, no identifiers
// beyond the session the object path already names.
//
// Why it exists: audio lost on the way to the server (a batch given up after
// its retries, a client buffer overflow, a tail lost at the end-of-session
// drain) is replaced in the WAV by digital silence of exactly the missing
// length, so every track keeps the client's timeline and the two tracks stay
// sample-aligned. But inserted zeros look exactly like a muted microphone
// (also exact zeros) and like true silence. Pause and timing measures on the
// participant track must exclude both, and this file is where they are.
//
// All positions and lengths are in SAMPLES of the track's own WAV (divide by
// sampleRate for seconds). Ranges are half-open: [start, start + length).
import { getObjectStream } from '../config/objectStorage.js';

export const SIDECAR_OBJECT_NAME = 'recording-tracks.json';
export const SIDECAR_VERSION = 1;
/**
 * WAV object metadata key (review of #105): 'stored', or 'missing' when the
 * sidecar upload failed (inserted silence then cannot be told from a muted
 * mic). Absent on recordings made before the sidecar existed.
 */
export const TRACK_DATA_METADATA_KEY = 'track-data';

/** Object key of a session's sidecar, next to recording.wav and participant.wav. */
export function recordingSidecarKey(sessionId: string): string {
  return `sessions/${sessionId}/${SIDECAR_OBJECT_NAME}`;
}

export interface SampleRange {
  start: number;
  length: number;
}

/**
 * A stretch of inserted digital silence. `reason`: 'sequence_gap' (chunks the
 * server never received between two it did) or 'lost_tail' (chunks the client
 * reported having captured after the last one that arrived). `capped` marks a
 * fill shorter than the audio missing (a single fill is capped at 60 s and a
 * track's total at its session's wall-clock span plus 60 s, so a bogus index
 * cannot write gigabytes); the track's timeline is not intact after a capped
 * fill.
 */
export interface GapRange extends SampleRange {
  chunks: number;
  reason: 'sequence_gap' | 'lost_tail';
  capped?: true;
  missingSamples?: number;
}

export interface TrackSidecar {
  object: 'recording.wav' | 'participant.wav';
  sampleRate: number;
  /** Samples in the WAV, inserted silence included. */
  totalSamples: number;
  /**
   * The client sent chunk indexes (every client since PR #95); false for older
   * clients; 'partial' when some batches came with indexes and some without
   * (the app was updated mid-session): the timeline is then not intact and
   * losses are unknown.
   */
  sequenced: boolean | 'partial';
  /** Samples per chunk used to size the fills (4096 from the browser); null if never known. */
  chunkSamples: number | null;
  /** Chunks of real audio written to the WAV. */
  chunksReceived: number;
  /** Chunks dropped because their index had already passed (a duplicate or late arrival). */
  chunksStale: number;
  /** Chunks the server knows were never received (inside gaps and the lost tail). */
  chunksMissing: number;
  /** Highest count of captured chunks the client reported; null when it reported none. */
  clientChunksPushed: number | null;
  insertedSilenceSamples: number;
  /** Stretches of inserted silence, all of them, even past the list's cap. */
  gapCount: number;
  gaps: GapRange[];
  /** More gaps than the list keeps (the counts above still cover all of them). */
  gapsTruncated: boolean;
  /** Real audio recorded while the participant's mic was muted (exact zeros by choice). */
  muted: SampleRange[];
  mutedSamples: number;
  mutedTruncated: boolean;
  /**
   * Sample n of this WAV is chunk-index time n on the client: the track is
   * sequenced and no fill was capped. Muted and silent stretches do not
   * affect it.
   */
  timelineIntact: boolean;
  /**
   * Sequenced, no missing chunks, no write error; null when not sequenced
   * (unknown). Stale chunks do not count: a duplicate was already stored, and
   * a late chunk's place was already filled and counted as missing.
   */
  complete: boolean | null;
}

export interface RecordingSidecar {
  version: typeof SIDECAR_VERSION;
  tracks: Partial<Record<'mixed' | 'participant', TrackSidecar>>;
  /**
   * Both tracks are present, both timelines intact, same sample rate and
   * chunk size: sample n of recording.wav and of participant.wav come from
   * the same browser audio callback. Lengths can still differ at the end.
   */
  tracksAligned: boolean;
}

export function buildSidecar(tracks: RecordingSidecar['tracks']): RecordingSidecar {
  const { mixed, participant } = tracks;
  const tracksAligned = Boolean(
    mixed &&
      participant &&
      mixed.timelineIntact &&
      participant.timelineIntact &&
      mixed.sampleRate === participant.sampleRate &&
      mixed.chunkSamples === participant.chunkSamples,
  );
  return { version: SIDECAR_VERSION, tracks, tracksAligned };
}

/** Compact per-track numbers for the admin session view. */
export interface TrackSummary {
  durationMs: number;
  insertedSilenceMs: number;
  gapCount: number;
  mutedMs: number;
  sequenced: boolean | 'partial';
  complete: boolean | null;
  timelineIntact: boolean;
}

const toMs = (samples: number, sampleRate: number) => (sampleRate > 0 ? Math.round((samples / sampleRate) * 1000) : 0);

export function summarizeTrack(t: TrackSidecar): TrackSummary {
  return {
    durationMs: toMs(t.totalSamples, t.sampleRate),
    insertedSilenceMs: toMs(t.insertedSilenceSamples, t.sampleRate),
    gapCount: t.gapCount,
    mutedMs: toMs(t.mutedSamples, t.sampleRate),
    sequenced: t.sequenced,
    complete: t.complete,
    timelineIntact: t.timelineIntact,
  };
}

/**
 * Read a session's sidecar. null when there is none (recordings made before
 * ai-therapist-384, a failed upload) or it cannot be read; never throws.
 */
export async function readRecordingSidecar(sessionId: string): Promise<RecordingSidecar | null> {
  try {
    const { body } = await getObjectStream(recordingSidecarKey(sessionId));
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RecordingSidecar;
    if (!parsed || parsed.version !== SIDECAR_VERSION || typeof parsed.tracks !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The stretches of one track that pause and timing measures must skip:
 * inserted silence and muted audio, merged and sorted.
 */
export function excludedRanges(t: TrackSidecar): SampleRange[] {
  const all = [...t.gaps, ...t.muted]
    .map((r) => ({ start: r.start, length: r.length }))
    .filter((r) => r.length > 0)
    .sort((a, b) => a.start - b.start);
  const merged: SampleRange[] = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.start + last.length) {
      last.length = Math.max(last.length, r.start + r.length - last.start);
    } else merged.push({ ...r });
  }
  return merged;
}
