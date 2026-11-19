// Uploads teed PCM16 audio to the server over HTTP. The participant's
// Socket.io connection is unreliable through the tunnel, but ordinary HTTP
// (token, logging) works fine — so audio chunks are batched and POSTed here
// instead of emitted over a socket. Batching keeps the request rate low.
//
// The periodic batches are ordinary fetches, never `keepalive` (ai-therapist-372).
// Browsers cap the bodies of all keepalive requests a page has in flight at
// 64 KiB together (Fetch standard; WebKit and Chromium both enforce it) and
// reject the request that would go over with a network error. A session runs
// two uploaders (mix and participant track), and at 48 kHz each 400 ms batch
// is about 55 KB of base64, so the participant batch issued right after the
// mix batch was refused every time: participant.wav kept only the first
// 170 ms of a 140 s session. Keepalive only matters for a page that is being
// unloaded, and a live session's page is not.

export interface AudioUploader {
  /** Feed one base64 PCM16 chunk (matches startMixedTee's onChunk signature). */
  push: (base64Pcm16: string, sampleRate: number) => void;
  /** Flush any buffered audio and stop the timer. */
  stop: () => void;
}

export function createAudioUploader(
  sessionId: string,
  flushMs = 400,
  // 'mixed' (default, mic+assistant mixdown) or 'participant' (mic-only tap,
  // migration 086). Old servers ignore the extra field; old clients omit it
  // and the server defaults to 'mixed'.
  track: 'mixed' | 'participant' = 'mixed',
): AudioUploader {
  let buf: string[] = [];
  let sampleRate = 48000;
  let dead = false;
  const url = `/api/sessions/${sessionId}/audio`;

  const post = (body: string) => {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((res) => {
        // 410 = the server already finalized this recording (session ended or
        // auto-terminated); stop uploading instead of streaming into the void.
        if (res.status === 410) {
          dead = true;
          clearInterval(timer);
          buf = [];
        }
      })
      .catch(() => {
        /* best-effort; dropped audio just shortens the recording */
      });
  };

  const flush = (useBeacon = false) => {
    if (dead || buf.length === 0) return;
    const chunks = buf;
    buf = [];
    const body = JSON.stringify({ chunks, sampleRate, track });
    // On teardown try sendBeacon first so the last batch survives a page that
    // goes away right after. A beacon shares the same 64 KiB in-flight budget
    // and returns false when it would go over (the other track's final batch
    // usually holds it), so fall back to a plain fetch instead of losing it.
    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    }
    post(body);
  };

  const timer = setInterval(() => flush(false), flushMs);

  return {
    push: (pcm, sr) => {
      if (!dead) {
        sampleRate = sr;
        buf.push(pcm);
      }
    },
    stop: () => {
      clearInterval(timer);
      flush(true);
    },
  };
}
