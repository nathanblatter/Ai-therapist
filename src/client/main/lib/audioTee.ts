// Tees an assistant audio MediaStream (the WebRTC remote track) into PCM16
// chunks for live admin monitoring. Audio never reaches our server otherwise —
// it flows peer-to-peer over WebRTC — so we tap it in the participant's browser.

export interface AudioTeeHandle {
  stop: () => void;
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Start capturing PCM16 from a MediaStream. onChunk receives base64-encoded
 * PCM16 plus the sample rate. Returns a handle to stop and release resources.
 */
export function startAudioTee(
  stream: MediaStream,
  onChunk: (base64Pcm16: string, sampleRate: number) => void,
): AudioTeeHandle {
  const AudioCtx = window.AudioContext || (window as WebkitWindow).webkitAudioContext!;
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // The participant already hears the assistant via the WebRTC audio element;
  // route the tap through a muted gain so it doesn't double-play here.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    onChunk(int16ToBase64(pcm16), ctx.sampleRate);
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  return {
    stop: () => {
      try {
        processor.onaudioprocess = null;
        processor.disconnect();
        source.disconnect();
        mute.disconnect();
      } catch {
        // already torn down
      }
      void ctx.close();
    },
  };
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
