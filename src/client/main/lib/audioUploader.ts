// Uploads teed PCM16 audio to the server over HTTP. The participant's
// Socket.io connection is unreliable through the tunnel, but ordinary HTTP
// (token, logging) works fine — so audio chunks are batched and POSTed here
// instead of emitted over a socket. Batching keeps the request rate low.

export interface AudioUploader {
  /** Feed one base64 PCM16 chunk (matches startMixedTee's onChunk signature). */
  push: (base64Pcm16: string, sampleRate: number) => void;
  /** Flush any buffered audio and stop the timer. */
  stop: () => void;
}

export function createAudioUploader(sessionId: string, flushMs = 400): AudioUploader {
  let buf: string[] = [];
  let sampleRate = 48000;
  let dead = false;

  const flush = (useBeacon = false) => {
    if (dead || buf.length === 0) return;
    const chunks = buf;
    buf = [];
    const body = JSON.stringify({ chunks, sampleRate });
    // On teardown prefer sendBeacon so the last batch survives page unload.
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(`/api/sessions/${sessionId}/audio`, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(`/api/sessions/${sessionId}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).then((res) => {
      // 410 = the server already finalized this recording (session ended or
      // auto-terminated); stop uploading instead of streaming into the void.
      if (res.status === 410) {
        dead = true;
        clearInterval(timer);
        buf = [];
      }
    }).catch(() => { /* best-effort; dropped audio just shortens the recording */ });
  };

  const timer = setInterval(() => flush(false), flushMs);

  return {
    push: (pcm, sr) => { if (!dead) { sampleRate = sr; buf.push(pcm); } },
    stop: () => { clearInterval(timer); flush(true); },
  };
}
