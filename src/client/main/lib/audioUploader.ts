// Uploads teed PCM16 audio to the server over HTTP. The participant's
// Socket.io connection is unreliable through the tunnel, but ordinary HTTP
// (token, logging) works fine — so audio chunks are batched and POSTed here
// instead of emitted over a socket. Batching keeps the request rate low.
//
// Rules (ai-therapist-372), each one learned from a lost participant track:
//
// - No `keepalive` on the streaming batches. Browsers cap the bodies of all
//   keepalive requests a page has in flight at 64 KiB together and reject the
//   one that would go over. A session runs two uploaders (mix and participant
//   track) and at 48 kHz each 400 ms batch is about 55 KB of base64, so the
//   participant batch was refused every time and participant.wav kept 0.17 s
//   of a 140 s session.
// - ONE request in flight per uploader. The server appends in arrival order,
//   so two batches of the same track in flight at once (a phone on cellular
//   that stalls, then flushes) could land in either order. The next batch is
//   cut only when the previous one has been answered; the server answers only
//   after appending, so arrival order is send order.
// - Backpressure by coalescing. While a request is out, new chunks wait in the
//   pending buffer, and the next request carries all of them as one larger
//   batch (at most MAX_BATCH_BYTES, inside the server's 8 MB body limit). The
//   buffer is bounded (MAX_PENDING_BYTES); past it the OLDEST waiting chunks
//   are dropped and counted, never silently.
// - Retry, then count. A failed batch (network error, 408/429/5xx) is resent
//   in place, in order, up to MAX_ATTEMPTS times with a growing delay, and
//   only then counted lost.
// - Every batch carries `seq`, the per-track index of its first chunk, so the
//   server can see gaps and stale (duplicate or out-of-order) batches.
// - The end of a session drains: drain() sends what is left and resolves when
//   everything is answered or DRAIN_TIMEOUT_MS has passed, and the caller
//   ends the session on the server only after that, so the final batches are
//   not refused as arriving after finalisation.

export type RecordingTrack = 'mixed' | 'participant';

/** Server body limit is 8 MB (sessions.routes.ts); stay well inside it. */
export const MAX_BATCH_BYTES = 6 * 1024 * 1024;
/** Waiting audio per track: about 47 s at 48 kHz, 94 s at 24 kHz. */
export const MAX_PENDING_BYTES = 6 * 1024 * 1024;
/** Attempts per batch, the first included. */
export const MAX_ATTEMPTS = 3;
/** Delay before retry n is n times this. */
export const RETRY_BASE_MS = 500;
/** Longest drain() waits at the end of a session. */
export const DRAIN_TIMEOUT_MS = 3000;
/** Mic toggles kept for the mic_timeline report (client event detail is capped at 2 KB). */
export const MAX_MIC_TOGGLES = 60;

export interface UploaderStats {
  track: RecordingTrack;
  /** Requests the server answered 2xx. */
  batchesSent: number;
  chunksSent: number;
  /** Resends after a failed attempt. */
  retries: number;
  /** Batches given up on after MAX_ATTEMPTS (or refused as malformed). */
  batchesLost: number;
  chunksLost: number;
  /** Chunks dropped (oldest first) because the pending buffer was full. */
  chunksDropped: number;
  /** Chunks still unsent when drain() timed out or the page went away. */
  chunksUndelivered: number;
  /** Chunks handed to sendBeacon on page hide (delivery unknown). */
  chunksBeaconed: number;
  /** Chunks discarded because the server had already closed the recording (410). */
  chunksAfterClose: number;
  /** Largest pending buffer seen, in bytes. */
  maxPendingBytes: number;
}

export interface MicTimeline {
  /** [offset in this track's audio, ms; 1 = mic on, 0 = muted], first entry at 0. */
  toggles: Array<[number, 0 | 1]>;
  truncated: boolean;
  mutedMs: number;
  totalMs: number;
}

export interface AudioUploader {
  readonly track: RecordingTrack;
  /** Feed one base64 PCM16 chunk; `muted` = the mic track was disabled for it. */
  push: (base64Pcm16: string, sampleRate: number, muted?: boolean) => void;
  /** Stop accepting audio, send everything left in order, resolve when done or at the timeout. */
  drain: (timeoutMs?: number) => Promise<UploaderStats>;
  /** Page is going away: hand what fits in `budgetBytes` to sendBeacon. Returns bytes used. */
  beaconFinal: (budgetBytes: number) => number;
  stats: () => UploaderStats;
  micTimeline: () => MicTimeline;
}

export interface AudioUploaderOptions {
  flushMs?: number;
  maxBatchBytes?: number;
  maxPendingBytes?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
}

interface Pending {
  index: number;
  pcm: string;
  muted: boolean;
}

interface Batch {
  items: Pending[];
  attempts: number;
}

const isRetryable = (status: number) => status === 408 || status === 429 || status >= 500;

export function createAudioUploader(
  sessionId: string,
  // 'mixed' (default, mic+assistant mixdown) or 'participant' (mic-only tap,
  // migration 086). Old servers ignore the extra fields; old clients omit
  // them and the server defaults to 'mixed'.
  track: RecordingTrack = 'mixed',
  options: AudioUploaderOptions = {},
): AudioUploader {
  const flushMs = options.flushMs ?? 400;
  const maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES;
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const url = `/api/sessions/${sessionId}/audio`;

  const stats: UploaderStats = {
    track,
    batchesSent: 0,
    chunksSent: 0,
    retries: 0,
    batchesLost: 0,
    chunksLost: 0,
    chunksDropped: 0,
    chunksUndelivered: 0,
    chunksBeaconed: 0,
    chunksAfterClose: 0,
    maxPendingBytes: 0,
  };

  let sampleRate = 48000;
  let nextIndex = 0;
  let pending: Pending[] = [];
  let pendingBytes = 0;
  // The batch being sent or waiting for its retry; null when idle.
  let current: Batch | null = null;
  let inFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false; // 410 from the server, or abandoned
  let draining = false;
  let drainDone: (() => void) | null = null;

  // Mic timeline, in this track's own audio time.
  let samplesPushed = 0;
  let mutedSamples = 0;
  let lastMuted: boolean | null = null;
  const toggles: Array<[number, 0 | 1]> = [];
  let togglesTruncated = false;

  const bodyFor = (items: Pending[]) => {
    const muted: number[] = [];
    items.forEach((it, i) => {
      if (it.muted) muted.push(i);
    });
    return JSON.stringify({
      chunks: items.map((it) => it.pcm),
      sampleRate,
      track,
      seq: items[0].index,
      ...(muted.length > 0 ? { muted } : {}),
    });
  };

  const cutBatch = (): Batch | null => {
    if (pending.length === 0) return null;
    const items: Pending[] = [];
    let bytes = 0;
    while (pending.length > 0) {
      const next = pending[0];
      if (items.length > 0 && bytes + next.pcm.length > maxBatchBytes) break;
      items.push(next);
      bytes += next.pcm.length;
      pending.shift();
    }
    pendingBytes -= bytes;
    return { items, attempts: 0 };
  };

  const settleDrainIfDone = () => {
    if (drainDone && !current && pending.length === 0) {
      const done = drainDone;
      drainDone = null;
      done();
    }
  };

  const giveUpCurrent = () => {
    if (!current) return;
    stats.batchesLost += 1;
    stats.chunksLost += current.items.length;
    current = null;
  };

  const send = () => {
    if (!current || inFlight || closed) return;
    const batch = current;
    batch.attempts += 1;
    if (batch.attempts > 1) stats.retries += 1;
    inFlight = true;
    let status: number | null = null;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyFor(batch.items),
    })
      .then(
        (res) => {
          status = res.status;
        },
        () => {
          status = null; // network error
        },
      )
      .then(() => {
        inFlight = false;
        if (closed) return;
        if (status === 410) {
          // The server already finalized this recording (session ended or
          // auto-terminated): stop instead of streaming into the void.
          closed = true;
          clearInterval(timer);
          stats.chunksAfterClose += batch.items.length + pending.length;
          current = null;
          pending = [];
          pendingBytes = 0;
          settleDrainIfDone();
          return;
        }
        if (status !== null && status >= 200 && status < 300) {
          stats.batchesSent += 1;
          stats.chunksSent += batch.items.length;
          current = null;
        } else if ((status === null || isRetryable(status)) && batch.attempts < maxAttempts) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            send();
          }, retryBaseMs * batch.attempts);
          return;
        } else {
          giveUpCurrent();
        }
        // While draining, keep going without waiting for the next tick.
        if (draining) pump();
        settleDrainIfDone();
      });
  };

  const pump = () => {
    if (closed || current) return;
    current = cutBatch();
    if (current) send();
  };

  const timer = setInterval(pump, flushMs);

  const dropOldestToFit = (incoming: number) => {
    while (pending.length > 0 && pendingBytes + incoming > maxPendingBytes) {
      const dropped = pending.shift()!;
      pendingBytes -= dropped.pcm.length;
      stats.chunksDropped += 1;
    }
  };

  const recordMic = (muted: boolean, samples: number) => {
    if (muted !== lastMuted) {
      if (toggles.length < MAX_MIC_TOGGLES) {
        toggles.push([Math.round((samplesPushed / sampleRate) * 1000), muted ? 0 : 1]);
      } else {
        togglesTruncated = true;
      }
      lastMuted = muted;
    }
    if (muted) mutedSamples += samples;
    samplesPushed += samples;
  };

  const abandon = () => {
    closed = true;
    clearInterval(timer);
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  return {
    track,
    push: (pcm, sr, muted = false) => {
      if (closed || draining) return;
      sampleRate = sr;
      // base64 length * 3/4 = bytes; / 2 = samples
      recordMic(muted, Math.floor((pcm.length * 3) / 4 / 2));
      dropOldestToFit(pcm.length);
      pending.push({ index: nextIndex++, pcm, muted });
      pendingBytes += pcm.length;
      if (pendingBytes > stats.maxPendingBytes) stats.maxPendingBytes = pendingBytes;
    },
    drain: (timeoutMs = DRAIN_TIMEOUT_MS) => {
      clearInterval(timer);
      draining = true;
      if (closed) return Promise.resolve({ ...stats });
      return new Promise<UploaderStats>((resolve) => {
        const deadline = setTimeout(() => {
          drainDone = null;
          stats.chunksUndelivered += pending.length + (current ? current.items.length : 0);
          pending = [];
          pendingBytes = 0;
          current = null;
          abandon();
          resolve({ ...stats });
        }, timeoutMs);
        drainDone = () => {
          clearTimeout(deadline);
          abandon();
          resolve({ ...stats });
        };
        // A batch waiting for its retry goes now rather than after its delay.
        if (retryTimer && current) {
          clearTimeout(retryTimer);
          retryTimer = null;
          send();
        }
        pump();
        settleDrainIfDone();
      });
    },
    beaconFinal: (budgetBytes) => {
      const waiting = [...(current && !inFlight ? current.items : []), ...pending];
      const inFlightCount = current && inFlight ? current.items.length : 0;
      abandon();
      pending = [];
      pendingBytes = 0;
      current = null;
      if (waiting.length === 0) {
        stats.chunksUndelivered += inFlightCount;
        return 0;
      }
      // Oldest first, so the server's sequence stays contiguous.
      const take: Pending[] = [];
      for (const item of waiting) {
        if (bodyFor([...take, item]).length > budgetBytes) break;
        take.push(item);
      }
      let used = 0;
      if (take.length > 0 && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const body = bodyFor(take);
        if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) {
          used = body.length;
          stats.chunksBeaconed += take.length;
        }
      }
      stats.chunksUndelivered += waiting.length - (used > 0 ? take.length : 0) + inFlightCount;
      return used;
    },
    stats: () => ({ ...stats }),
    micTimeline: () => ({
      toggles: toggles.map((t) => [t[0], t[1]] as [number, 0 | 1]),
      truncated: togglesTruncated,
      mutedMs: Math.round((mutedSamples / sampleRate) * 1000),
      totalMs: Math.round((samplesPushed / sampleRate) * 1000),
    }),
  };
}

/** Whether the participant's mic is muted: the mic button disables the stream's audio track. */
export function isMicMuted(stream: MediaStream): boolean {
  const t = stream.getAudioTracks()[0];
  return !t || !t.enabled;
}

/** Numbers-only summary of one track's upload, for the audio_upload_summary client event. */
function summarize(s: UploaderStats) {
  return {
    sent: s.chunksSent,
    batches: s.batchesSent,
    retries: s.retries,
    lostBatches: s.batchesLost,
    lost: s.chunksLost,
    dropped: s.chunksDropped,
    undelivered: s.chunksUndelivered,
    beaconed: s.chunksBeaconed,
    afterClose: s.chunksAfterClose,
    maxPendingBytes: s.maxPendingBytes,
  };
}

export type ReportFn = (kind: 'audio_upload_summary' | 'mic_timeline', detail: Record<string, unknown>) => void;

/**
 * End of a session: drain both uploaders (in parallel, bounded by the drain
 * timeout), then report the counts and the participant's mic timeline once.
 * Resolves when both are done; never rejects.
 */
export async function drainAndReport(
  uploaders: { mixed: AudioUploader | null; participant: AudioUploader | null },
  report: ReportFn,
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<void> {
  const [mixed, participant] = await Promise.all([
    uploaders.mixed ? uploaders.mixed.drain(timeoutMs) : Promise.resolve(null),
    uploaders.participant ? uploaders.participant.drain(timeoutMs) : Promise.resolve(null),
  ]);
  reportTracks(mixed, participant, uploaders.participant, report);
}

function reportTracks(
  mixed: UploaderStats | null,
  participant: UploaderStats | null,
  participantUploader: AudioUploader | null,
  report: ReportFn,
): void {
  try {
    if (mixed || participant) {
      report('audio_upload_summary', {
        ...(mixed ? { mixed: summarize(mixed) } : {}),
        ...(participant ? { participant: summarize(participant) } : {}),
      });
    }
    if (participantUploader) report('mic_timeline', { ...participantUploader.micTimeline() });
  } catch {
    /* telemetry never breaks teardown */
  }
}

/**
 * Page hide: beacon the unsent tail of both tracks inside `budgetBytes`,
 * participant track first (it is the one the study analyses). Whatever does
 * not fit is lost and counted in each uploader's stats. Returns bytes used.
 */
export function beaconRecordingTail(
  uploaders: { mixed: AudioUploader | null; participant: AudioUploader | null },
  budgetBytes: number,
): number {
  let left = Math.max(0, budgetBytes);
  if (uploaders.participant) left -= uploaders.participant.beaconFinal(left);
  if (uploaders.mixed) left -= uploaders.mixed.beaconFinal(left);
  return budgetBytes - left;
}
