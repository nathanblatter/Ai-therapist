// Soft generated ambience for voice sessions: looped brown noise through a
// low-pass filter with a slow "tide" swell. Everything is synthesized locally
// (no audio assets) and kept very quiet so it sits under the conversation.

export interface SoundscapeHandle {
  stop: () => void;
}

const AMBIENCE_STORAGE_KEY = 'app-ambience';

export function getAmbiencePreference(): boolean {
  try {
    return window.localStorage.getItem(AMBIENCE_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setAmbiencePreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(AMBIENCE_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage unavailable — the in-session toggle still works.
  }
}

export function startSoundscape(): SoundscapeHandle {
  const ctx = new AudioContext();

  // ~4s of brown noise, looped (brown = integrated white, much softer top end).
  const seconds = 4;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  // Crossfade-free loop seam: taper the ends toward the shared start value.
  const seam = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < seam; i++) {
    const k = i / seam;
    data[data.length - seam + i] = data[data.length - seam + i] * (1 - k) + data[0] * k;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  filter.Q.value = 0.4;

  // Slow swell (~0.08 Hz) so it reads as tide rather than static.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.08;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.008;

  const master = ctx.createGain();
  master.gain.value = 0; // fade in below
  lfo.connect(lfoGain).connect(master.gain);

  source.connect(filter).connect(master).connect(ctx.destination);
  source.start();
  lfo.start();
  master.gain.linearRampToValueAtTime(0.025, ctx.currentTime + 2);

  return {
    stop: () => {
      try {
        master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
        setTimeout(() => void ctx.close(), 600);
      } catch {
        void ctx.close();
      }
    },
  };
}
