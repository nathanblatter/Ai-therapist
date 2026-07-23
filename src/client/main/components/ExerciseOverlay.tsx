// Full-screen guided-exercise overlay (ai-therapist-26), launched when the AI
// calls start_breathing_exercise / start_grounding_exercise. Triggered from the
// WebRTC data channel (the client sees the same function-call event the server
// executes), so it works even where the participant Socket.io connection
// doesn't. The AI narrates alongside; this is the visual half.
import { useState, useEffect } from 'react';
import { X } from 'react-feather';

export type ExerciseType = 'breathing' | 'grounding' | 'body_scan';

export interface ActiveExercise {
  type: ExerciseType;
  durationSeconds?: number;
}

interface ExerciseOverlayProps {
  exercise: ActiveExercise | null;
  onClose: () => void;
}

// 4-4-4-4 box breathing, one phase per 4 seconds.
const BREATH_PHASES = [
  { label: 'Breathe in', scale: 'scale-100' },
  { label: 'Hold', scale: 'scale-100' },
  { label: 'Breathe out', scale: 'scale-50' },
  { label: 'Hold', scale: 'scale-50' },
] as const;
const PHASE_SECONDS = 4;

function BreathingExercise({ durationSeconds = 60, onClose }: { durationSeconds?: number; onClose: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(durationSeconds);
  const [phaseIndex, setPhaseIndex] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setSecondsLeft(s => s - 1), 1000);
    const phase = setInterval(() => setPhaseIndex(p => (p + 1) % BREATH_PHASES.length), PHASE_SECONDS * 1000);
    return () => { clearInterval(tick); clearInterval(phase); };
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) onClose();
  }, [secondsLeft, onClose]);

  const phase = BREATH_PHASES[phaseIndex];

  return (
    <div className="flex flex-col items-center gap-10">
      <div className="relative flex items-center justify-center" style={{ width: 260, height: 260 }}>
        <div
          className={`absolute rounded-full bg-blue-400 bg-opacity-30 transition-transform ease-in-out ${phase.scale}`}
          style={{ width: 260, height: 260, transitionDuration: `${PHASE_SECONDS * 1000}ms` }}
        />
        <div
          className={`absolute rounded-full bg-blue-500 bg-opacity-40 transition-transform ease-in-out ${phase.scale}`}
          style={{ width: 190, height: 190, transitionDuration: `${PHASE_SECONDS * 1000}ms` }}
        />
        <p className="relative text-white text-2xl font-light" aria-live="polite">{phase.label}</p>
      </div>
      <p className="text-blue-100 text-sm">{Math.max(secondsLeft, 0)}s remaining — breathe with the circle</p>
    </div>
  );
}

const GROUNDING_STEPS = [
  { count: 5, sense: 'things you can see', hint: 'Look around slowly. Name them out loud.' },
  { count: 4, sense: 'things you can touch', hint: 'Notice texture and temperature.' },
  { count: 3, sense: 'things you can hear', hint: 'Near sounds and far sounds.' },
  { count: 2, sense: 'things you can smell', hint: 'Or two smells you like.' },
  { count: 1, sense: 'thing you can taste', hint: 'Or one thing you’re grateful for.' },
] as const;

function GroundingExercise({ onClose }: { onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = GROUNDING_STEPS[stepIndex];
  const isLast = stepIndex === GROUNDING_STEPS.length - 1;

  return (
    <div className="flex flex-col items-center gap-8 max-w-md text-center px-6">
      <div className="flex gap-2" aria-hidden="true">
        {GROUNDING_STEPS.map((s, i) => (
          <div key={s.count} className={`h-1.5 w-10 rounded-full ${i <= stepIndex ? 'bg-blue-300' : 'bg-white bg-opacity-20'}`} />
        ))}
      </div>
      <div>
        <p className="text-blue-200 text-sm uppercase tracking-wide mb-2">Grounding · 5-4-3-2-1</p>
        <p className="text-white text-3xl font-light mb-3" aria-live="polite">
          Notice <span className="font-semibold">{step.count}</span> {step.sense}
        </p>
        <p className="text-blue-100">{step.hint}</p>
      </div>
      <button
        onClick={() => (isLast ? onClose() : setStepIndex(stepIndex + 1))}
        className="bg-white bg-opacity-15 hover:bg-opacity-25 text-white px-8 py-3 rounded-full text-sm font-medium transition-colors min-h-[44px]"
      >
        {isLast ? 'Done' : 'Next'}
      </button>
    </div>
  );
}

// Progressive relaxation: attention travels foot-to-head, softening each area.
const BODY_SCAN_STEPS = [
  { region: 'your feet and toes', cue: 'Notice contact with the floor — warmth, weight. Let them soften.' },
  { region: 'your legs', cue: 'Let the muscles grow heavy and loose.' },
  { region: 'your hips and lower back', cue: 'Release any holding here.' },
  { region: 'your belly', cue: 'Let it rise and fall with each breath.' },
  { region: 'your chest', cue: 'Notice your heartbeat, and let your breath slow.' },
  { region: 'your hands and arms', cue: 'Unclench your hands; let your arms rest.' },
  { region: 'your shoulders and neck', cue: 'Let your shoulders drop away from your ears.' },
  { region: 'your face and jaw', cue: 'Soften your jaw, forehead, and the space between your brows.' },
] as const;

function BodyScan({ durationSeconds = 120, onClose }: { durationSeconds?: number; onClose: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(durationSeconds);
  const [stepIndex, setStepIndex] = useState(0);
  const stepMs = Math.max(4000, Math.round((durationSeconds * 1000) / BODY_SCAN_STEPS.length));

  useEffect(() => {
    const tick = setInterval(() => setSecondsLeft(s => s - 1), 1000);
    const advance = setInterval(() => setStepIndex(i => i + 1), stepMs);
    return () => { clearInterval(tick); clearInterval(advance); };
  }, [stepMs]);

  useEffect(() => {
    if (stepIndex >= BODY_SCAN_STEPS.length || secondsLeft <= 0) onClose();
  }, [stepIndex, secondsLeft, onClose]);

  const step = BODY_SCAN_STEPS[Math.min(stepIndex, BODY_SCAN_STEPS.length - 1)];

  return (
    <div className="flex flex-col items-center gap-8 max-w-md text-center px-6">
      <div className="flex gap-1.5" aria-hidden="true">
        {BODY_SCAN_STEPS.map((s, i) => (
          <div key={s.region} className={`h-1.5 w-6 rounded-full ${i <= stepIndex ? 'bg-blue-300' : 'bg-white bg-opacity-20'}`} />
        ))}
      </div>
      <div className="relative flex items-center justify-center" style={{ width: 200, height: 200 }}>
        <div className="absolute rounded-full bg-blue-400 bg-opacity-20 animate-ping" style={{ width: 200, height: 200, animationDuration: '3s' }} />
        <div className="absolute rounded-full bg-blue-500 bg-opacity-30" style={{ width: 130, height: 130 }} />
      </div>
      <div>
        <p className="text-blue-200 text-sm uppercase tracking-wide mb-2">Body scan</p>
        <p className="text-white text-2xl font-light mb-3" aria-live="polite">
          Bring gentle attention to <span className="font-semibold">{step.region}</span>
        </p>
        <p className="text-blue-100">{step.cue}</p>
      </div>
      <p className="text-blue-100 text-sm">{Math.max(secondsLeft, 0)}s remaining</p>
    </div>
  );
}

export default function ExerciseOverlay({ exercise, onClose }: ExerciseOverlayProps) {
  if (!exercise) return null;

  const label = exercise.type === 'breathing' ? 'Breathing exercise'
    : exercise.type === 'body_scan' ? 'Body scan exercise'
    : 'Grounding exercise';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'linear-gradient(160deg, #1e3a5f 0%, #0f2340 100%)' }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 text-blue-200 hover:text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
        aria-label="End exercise"
      >
        <X size={22} />
      </button>
      {exercise.type === 'breathing' && <BreathingExercise durationSeconds={exercise.durationSeconds} onClose={onClose} />}
      {exercise.type === 'grounding' && <GroundingExercise onClose={onClose} />}
      {exercise.type === 'body_scan' && <BodyScan durationSeconds={exercise.durationSeconds} onClose={onClose} />}
    </div>
  );
}
