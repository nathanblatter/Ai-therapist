// Themed listening/speaking indicator for voice sessions. Colors come from
// the theme tokens (--t-orb-a/--t-orb-b), levels from Web Audio analysers on
// the mic and assistant streams. Includes the optional ambience toggle.
import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'react-feather';
import {
  startSoundscape,
  getAmbiencePreference,
  setAmbiencePreference,
  type SoundscapeHandle,
} from '../lib/soundscape';

interface VoiceOrbProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

type OrbState = 'idle' | 'listening' | 'speaking';

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'Mic muted — press the mic button to talk',
  listening: 'Listening…',
  speaking: 'AI is speaking',
};

function makeLevelReader(ctx: AudioContext, stream: MediaStream): () => number {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  return () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length); // RMS 0..1
  };
}

export default function VoiceOrb({ localStream, remoteStream }: VoiceOrbProps) {
  const orbRef = useRef<HTMLDivElement | null>(null);
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [ambienceOn, setAmbienceOn] = useState(false);
  const soundscapeRef = useRef<SoundscapeHandle | null>(null);

  // Level-driven animation loop
  useEffect(() => {
    if (!localStream && !remoteStream) return;

    const ctx = new AudioContext();
    const readLocal = localStream ? makeLevelReader(ctx, localStream) : null;
    const readRemote = remoteStream ? makeLevelReader(ctx, remoteStream) : null;

    const reduceMotion =
      document.documentElement.getAttribute('data-motion') === 'reduce' ||
      (document.documentElement.getAttribute('data-motion') !== 'allow' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    let raf = 0;
    let lastState: OrbState = 'idle';
    const tick = () => {
      const remoteLevel = readRemote ? readRemote() : 0;
      const micEnabled = localStream?.getAudioTracks()[0]?.enabled ?? false;
      const localLevel = micEnabled && readLocal ? readLocal() : 0;

      const state: OrbState = remoteLevel > 0.02 ? 'speaking' : micEnabled ? 'listening' : 'idle';
      if (state !== lastState) {
        lastState = state;
        setOrbState(state);
      }

      if (orbRef.current && !reduceMotion) {
        const level = Math.min(1, Math.max(remoteLevel, localLevel) * 6);
        orbRef.current.style.transform = `scale(${1 + level * 0.3})`;
        orbRef.current.style.boxShadow = `0 0 ${24 + level * 40}px rgb(var(--t-orb-a) / ${0.35 + level * 0.4})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [localStream, remoteStream]);

  // Ambience: honor the remembered preference when the session starts
  useEffect(() => {
    if (getAmbiencePreference()) {
      soundscapeRef.current = startSoundscape();
      setAmbienceOn(true);
    }
    return () => {
      soundscapeRef.current?.stop();
      soundscapeRef.current = null;
    };
  }, []);

  const toggleAmbience = () => {
    if (ambienceOn) {
      soundscapeRef.current?.stop();
      soundscapeRef.current = null;
    } else {
      soundscapeRef.current = startSoundscape();
    }
    setAmbienceOn(!ambienceOn);
    setAmbiencePreference(!ambienceOn);
  };

  return (
    <div className="flex items-center justify-center gap-3 py-2" role="status" aria-live="polite">
      <div className="w-10 h-10 flex items-center justify-center" aria-hidden="true">
        <div
          ref={orbRef}
          className={`voice-orb w-8 h-8 rounded-full ${orbState === 'idle' ? 'voice-orb--idle opacity-60' : ''}`}
        />
      </div>
      <span className="text-sm text-ink-muted">{STATE_LABEL[orbState]}</span>
      <button
        onClick={toggleAmbience}
        className="p-2 rounded-full text-gray-500 hover:bg-gray-100 transition-colors"
        title={ambienceOn ? 'Turn off background ambience' : 'Play soft background ambience'}
        aria-label={ambienceOn ? 'Mute background ambience' : 'Play soft background ambience'}
        aria-pressed={ambienceOn}
      >
        {ambienceOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>
    </div>
  );
}
