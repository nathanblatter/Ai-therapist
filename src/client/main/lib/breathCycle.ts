// Timing model for the guided breathing overlay: 4-4-4-4 box breathing. One
// pure function maps elapsed time to everything the animation draws, so the
// label, the count, the orb size and the progress ring can never drift apart.

export const BREATH_PHASES = [
  { key: 'in', label: 'Breathe in' },
  { key: 'hold_full', label: 'Hold' },
  { key: 'out', label: 'Breathe out' },
  { key: 'hold_empty', label: 'Hold' },
] as const;

export const PHASE_MS = 4000;
export const CYCLE_MS = PHASE_MS * BREATH_PHASES.length;

/** Orb scale at empty lungs; full lungs is 1. */
export const MIN_SCALE = 0.56;

export interface BreathFrame {
  /** Index into BREATH_PHASES. */
  phaseIndex: number;
  /** 0..1 through the current phase. */
  phaseProgress: number;
  /** 0..1 through the whole four-phase cycle (drives the ring marker). */
  cycleProgress: number;
  /** Orb scale, MIN_SCALE..1, eased so the breath starts and ends gently. */
  scale: number;
  /** The count to show for this phase: 1 up to 4. */
  count: number;
}

function easeInOutSine(t: number): number {
  return 0.5 - Math.cos(Math.PI * t) / 2;
}

export function breathFrame(elapsedMs: number): BreathFrame {
  const elapsed = Math.max(0, elapsedMs);
  const inCycle = elapsed % CYCLE_MS;
  const phaseIndex = Math.min(BREATH_PHASES.length - 1, Math.floor(inCycle / PHASE_MS));
  const phaseProgress = (inCycle - phaseIndex * PHASE_MS) / PHASE_MS;
  const eased = easeInOutSine(phaseProgress);
  const range = 1 - MIN_SCALE;

  let scale: number;
  switch (BREATH_PHASES[phaseIndex].key) {
    case 'in':
      scale = MIN_SCALE + range * eased;
      break;
    case 'hold_full':
      scale = 1;
      break;
    case 'out':
      scale = 1 - range * eased;
      break;
    default:
      scale = MIN_SCALE;
  }

  const phaseSeconds = PHASE_MS / 1000;
  const count = Math.min(phaseSeconds, Math.floor(phaseProgress * phaseSeconds) + 1);

  return { phaseIndex, phaseProgress, cycleProgress: inCycle / CYCLE_MS, scale, count };
}

/** "1:05" style clock for the time remaining. */
export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
