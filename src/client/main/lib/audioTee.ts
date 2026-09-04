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

/**
 * Tee several MediaStreams mixed down into a single PCM16 stream. Used to
 * capture the whole conversation (participant mic + assistant voice) as one
 * combined recording. Each source is attenuated slightly to leave headroom
 * before the summed signal is clamped. Returns a handle to stop and release.
 */
export function startMixedTee(
  streams: MediaStream[],
  onChunk: (base64Pcm16: string, sampleRate: number) => void,
  // Optional second tap: emit the given stream (the participant's mic) on its
  // own, PRE-GAIN, alongside the mix. Consent-wise this is a subset of audio
  // already in the mixed recording; it exists so prosody research gets clean
  // participant speech (the mix sums mic + assistant irrecoverably).
  participantTap?: {
    stream: MediaStream;
    onChunk: (base64Pcm16: string, sampleRate: number) => void;
  },
): AudioTeeHandle {
  const AudioCtx = window.AudioContext || (window as WebkitWindow).webkitAudioContext!;
  const ctx = new AudioCtx();
  // The context is created during async WebRTC negotiation (not directly in the
  // click handler), so it starts suspended and would never fire onaudioprocess.
  // A prior user gesture exists (starting the session), so resume() succeeds.
  const ensureRunning = () => { if (ctx.state === 'suspended') void ctx.resume(); };
  ensureRunning();
  // Belt-and-suspenders: also resume on the next user interaction.
  const onGesture = () => ensureRunning();
  window.addEventListener('pointerdown', onGesture, { once: true });

  const processor = ctx.createScriptProcessor(4096, 1, 1);
  let started = false;

  // One gain per source feeds the same processor input; Web Audio sums them.
  const sources = streams
    .filter((s) => s && s.getAudioTracks().length > 0)
    .map((stream) => {
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 0.85; // headroom so two simultaneous voices don't clip hard
      src.connect(gain);
      gain.connect(processor);
      return { src, gain };
    });

  processor.onaudioprocess = (e) => {
    if (!started) {
      started = true;
      console.log('[MixedTee] capturing audio @', ctx.sampleRate, 'Hz');
    }
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    onChunk(int16ToBase64(pcm16), ctx.sampleRate);
  };

  // Route through a muted gain so the tap doesn't double-play locally.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(ctx.destination);

  // Participant-only tap: a second processor on the same context, fed by the
  // mic's source node directly (pre-gain — no 0.85 attenuation, clean signal).
  let participantProcessor: ScriptProcessorNode | null = null;
  let participantMute: GainNode | null = null;
  let participantSource: MediaStreamAudioSourceNode | null = null;
  if (participantTap && participantTap.stream.getAudioTracks().length > 0) {
    const micSource = ctx.createMediaStreamSource(participantTap.stream);
    participantSource = micSource;
    participantProcessor = ctx.createScriptProcessor(4096, 1, 1);
    participantProcessor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      participantTap.onChunk(int16ToBase64(pcm16), ctx.sampleRate);
    };
    micSource.connect(participantProcessor);
    participantMute = ctx.createGain();
    participantMute.gain.value = 0;
    participantProcessor.connect(participantMute);
    participantMute.connect(ctx.destination);
  }

  return {
    stop: () => {
      try {
        window.removeEventListener('pointerdown', onGesture);
        processor.onaudioprocess = null;
        processor.disconnect();
        mute.disconnect();
        if (participantProcessor) {
          participantProcessor.onaudioprocess = null;
          participantProcessor.disconnect();
        }
        participantMute?.disconnect();
        participantSource?.disconnect();
        for (const { src, gain } of sources) {
          src.disconnect();
          gain.disconnect();
        }
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
