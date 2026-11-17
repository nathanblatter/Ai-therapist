// Full-screen guided-exercise overlay (ai-therapist-26), launched when the AI
// calls start_breathing_exercise / start_grounding_exercise. Triggered from the
// WebRTC data channel (the client sees the same function-call event the server
// executes), so it works even where the participant Socket.io connection
// doesn't. The AI narrates alongside; this is the visual half.
import { useState, useEffect, useRef } from 'react';
import { X } from 'react-feather';
import { BREATH_PHASES, MIN_SCALE, breathFrame, formatRemaining } from '../lib/breathCycle';

export type ExerciseType = 'breathing' | 'grounding' | 'body_scan';

export interface ActiveExercise {
  type: ExerciseType;
  durationSeconds?: number;
}

interface ExerciseOverlayProps {
  exercise: ActiveExercise | null;
  /** Called exactly once when the exercise ends: 'completed' when it ran its
   *  course (timer elapsed / last grounding step done), 'dismissed' when the
   *  participant closed it early via the X. The parent reports this to the
   *  server so the live model knows the exercise is over (ai-therapist-112). */
  onFinish: (status: 'completed' | 'dismissed') => void;
}

// Ring geometry: four arcs, one per phase, drawn clockwise from the top.
const RING_SIZE = 300;
const RING_RADIUS = 138;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ARC_GAP_DEGREES = 5;
const ARC_LENGTH = (RING_CIRCUMFERENCE * (90 - ARC_GAP_DEGREES)) / 360;
const ORB_SIZE = 212;

// 4-4-4-4 box breathing. The orb grows on the in-breath, rests while held,
// shrinks on the out-breath, and the ring fills one quarter per phase. Size is
// painted straight to the DOM every frame from breathFrame(); React state only
// changes once a second (label, count, clock).
function BreathingExercise({ durationSeconds = 60, onClose }: { durationSeconds?: number; onClose: () => void }) {
  const orbRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const arcRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [view, setView] = useState({ phaseIndex: 0, count: 1, secondsLeft: durationSeconds });

  useEffect(() => {
    const reducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const startedAt = performance.now();
    let raf = 0;

    const paint = () => {
      const elapsed = performance.now() - startedAt;
      const frame = breathFrame(elapsed);
      // Reduced motion: the orb stays put and the ring steps a quarter at a
      // time; the label and count still carry the rhythm.
      const scale = reducedMotion ? 0.86 : frame.scale;
      const fullness = (frame.scale - MIN_SCALE) / (1 - MIN_SCALE);
      if (orbRef.current) orbRef.current.style.transform = `scale(${scale.toFixed(4)})`;
      if (haloRef.current) {
        haloRef.current.style.transform = `scale(${(scale * 1.04).toFixed(4)})`;
        haloRef.current.style.opacity = (reducedMotion ? 0.4 : 0.22 + 0.4 * fullness).toFixed(3);
      }
      arcRefs.current.forEach((arc, i) => {
        if (!arc) return;
        const filled =
          i < frame.phaseIndex ? 1 : i === frame.phaseIndex ? (reducedMotion ? 1 : frame.phaseProgress) : 0;
        arc.style.strokeDasharray = `${(ARC_LENGTH * filled).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
        // A zero-length dash with round caps still draws a dot; hide it.
        arc.style.opacity = filled > 0.002 ? '1' : '0';
      });

      const secondsLeft = Math.max(0, Math.ceil(durationSeconds - elapsed / 1000));
      setView((v) =>
        v.phaseIndex === frame.phaseIndex && v.count === frame.count && v.secondsLeft === secondsLeft
          ? v
          : { phaseIndex: frame.phaseIndex, count: frame.count, secondsLeft },
      );
    };

    const loop = () => {
      paint();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // Animation frames stop in a background tab; this keeps the clock (and the
    // end of the exercise) honest while the participant is looking elsewhere.
    const fallback = setInterval(paint, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(fallback);
    };
  }, [durationSeconds]);

  useEffect(() => {
    if (view.secondsLeft <= 0) onClose();
  }, [view.secondsLeft, onClose]);

  const phase = BREATH_PHASES[view.phaseIndex];
  const center = RING_SIZE / 2;

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="relative flex items-center justify-center" style={{ width: RING_SIZE, height: RING_SIZE }}>
        <svg
          className="absolute inset-0"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden="true"
        >
          {BREATH_PHASES.map((p, i) => {
            const rotate = `rotate(${-90 + i * 90 + ARC_GAP_DEGREES / 2} ${center} ${center})`;
            return (
              <g key={p.key} transform={rotate} fill="none" strokeWidth={4} strokeLinecap="round">
                <circle
                  cx={center}
                  cy={center}
                  r={RING_RADIUS}
                  stroke="rgba(255,255,255,0.14)"
                  strokeDasharray={`${ARC_LENGTH} ${RING_CIRCUMFERENCE}`}
                />
                <circle
                  ref={(el) => {
                    arcRefs.current[i] = el;
                  }}
                  cx={center}
                  cy={center}
                  r={RING_RADIUS}
                  stroke="rgba(191,219,254,0.95)"
                  strokeDasharray={`0 ${RING_CIRCUMFERENCE}`}
                  style={{ opacity: 0 }}
                />
              </g>
            );
          })}
        </svg>
        <div
          ref={haloRef}
          className="absolute rounded-full"
          style={{
            width: ORB_SIZE + 44,
            height: ORB_SIZE + 44,
            background: 'radial-gradient(circle, rgba(96,165,250,0.55) 0%, rgba(96,165,250,0) 70%)',
            filter: 'blur(14px)',
            transform: `scale(${MIN_SCALE})`,
            opacity: 0.22,
            willChange: 'transform, opacity',
          }}
        />
        <div
          ref={orbRef}
          className="absolute rounded-full"
          style={{
            width: ORB_SIZE,
            height: ORB_SIZE,
            background:
              'radial-gradient(circle at 34% 28%, rgba(147,197,253,0.62) 0%, rgba(59,130,246,0.5) 48%, rgba(30,64,175,0.5) 100%)',
            boxShadow: 'inset 0 0 36px rgba(191,219,254,0.22), 0 0 30px rgba(59,130,246,0.3)',
            transform: `scale(${MIN_SCALE})`,
            willChange: 'transform',
          }}
        />
        <div className="relative flex flex-col items-center" style={{ textShadow: '0 1px 10px rgba(15,35,64,0.75)' }}>
          <p className="text-white text-2xl font-light" aria-live="polite">
            {phase.label}
          </p>
          <p
            className="text-blue-100 text-4xl font-extralight mt-1"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            aria-hidden="true"
          >
            {view.count}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-blue-100 text-sm">In for 4, hold for 4, out for 4, hold for 4</p>
        <p className="text-blue-200 text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatRemaining(view.secondsLeft)} remaining
        </p>
      </div>
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
          <div
            key={s.count}
            className={`h-1.5 w-10 rounded-full ${i <= stepIndex ? 'bg-blue-300' : 'bg-white bg-opacity-20'}`}
          />
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
    const tick = setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    const advance = setInterval(() => setStepIndex((i) => i + 1), stepMs);
    return () => {
      clearInterval(tick);
      clearInterval(advance);
    };
  }, [stepMs]);

  useEffect(() => {
    if (stepIndex >= BODY_SCAN_STEPS.length || secondsLeft <= 0) onClose();
  }, [stepIndex, secondsLeft, onClose]);

  const step = BODY_SCAN_STEPS[Math.min(stepIndex, BODY_SCAN_STEPS.length - 1)];

  return (
    <div className="flex flex-col items-center gap-8 max-w-md text-center px-6">
      <div className="flex gap-1.5" aria-hidden="true">
        {BODY_SCAN_STEPS.map((s, i) => (
          <div
            key={s.region}
            className={`h-1.5 w-6 rounded-full ${i <= stepIndex ? 'bg-blue-300' : 'bg-white bg-opacity-20'}`}
          />
        ))}
      </div>
      <div className="relative flex items-center justify-center" style={{ width: 200, height: 200 }}>
        <div
          className="absolute rounded-full bg-blue-400 bg-opacity-20 animate-ping"
          style={{ width: 200, height: 200, animationDuration: '3s' }}
        />
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

export default function ExerciseOverlay({ exercise, onFinish }: ExerciseOverlayProps) {
  if (!exercise) return null;

  const label =
    exercise.type === 'breathing'
      ? 'Breathing exercise'
      : exercise.type === 'body_scan'
        ? 'Body scan exercise'
        : 'Grounding exercise';

  const complete = () => onFinish('completed');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'linear-gradient(160deg, #1e3a5f 0%, #0f2340 100%)' }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button
        onClick={() => onFinish('dismissed')}
        className="absolute top-4 right-4 p-2 text-blue-200 hover:text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
        aria-label="End exercise"
      >
        <X size={22} />
      </button>
      {exercise.type === 'breathing' && (
        <BreathingExercise durationSeconds={exercise.durationSeconds} onClose={complete} />
      )}
      {exercise.type === 'grounding' && <GroundingExercise onClose={complete} />}
      {exercise.type === 'body_scan' && <BodyScan durationSeconds={exercise.durationSeconds} onClose={complete} />}
    </div>
  );
}
