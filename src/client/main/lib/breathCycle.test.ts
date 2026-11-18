import { describe, it, expect } from 'vitest';
import { breathFrame, formatRemaining, BREATH_PHASES, CYCLE_MS, MIN_SCALE, PHASE_MS } from './breathCycle';

describe('breathFrame', () => {
  it('starts empty and breathing in, so the first thing the orb does is grow', () => {
    const f = breathFrame(0);
    expect(BREATH_PHASES[f.phaseIndex].key).toBe('in');
    expect(f.scale).toBeCloseTo(MIN_SCALE);
    expect(f.count).toBe(1);
    expect(breathFrame(1000).scale).toBeGreaterThan(f.scale);
  });

  it('walks in, hold, out, hold in four-second phases', () => {
    const keys = [0, 1, 2, 3].map((i) => BREATH_PHASES[breathFrame(i * PHASE_MS + 10).phaseIndex].key);
    expect(keys).toEqual(['in', 'hold_full', 'out', 'hold_empty']);
  });

  it('holds the orb still at full and at empty', () => {
    expect(breathFrame(PHASE_MS + 100).scale).toBe(1);
    expect(breathFrame(PHASE_MS * 2 - 100).scale).toBe(1);
    expect(breathFrame(PHASE_MS * 3 + 100).scale).toBe(MIN_SCALE);
    expect(breathFrame(PHASE_MS * 4 - 100).scale).toBe(MIN_SCALE);
  });

  it('has no jump in size at any phase boundary', () => {
    for (let boundary = PHASE_MS; boundary <= CYCLE_MS * 2; boundary += PHASE_MS) {
      const before = breathFrame(boundary - 1).scale;
      const after = breathFrame(boundary + 1).scale;
      expect(Math.abs(before - after)).toBeLessThan(0.001);
    }
  });

  it('shrinks through the exhale and stays within bounds throughout', () => {
    const start = PHASE_MS * 2;
    expect(breathFrame(start + 3000).scale).toBeLessThan(breathFrame(start + 1000).scale);
    for (let t = 0; t < CYCLE_MS; t += 137) {
      const { scale } = breathFrame(t);
      expect(scale).toBeGreaterThanOrEqual(MIN_SCALE - 1e-9);
      expect(scale).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('counts 1 to 4 within each phase', () => {
    expect([0, 1000, 2000, 3000, 3999].map((t) => breathFrame(t).count)).toEqual([1, 2, 3, 4, 4]);
    expect(breathFrame(PHASE_MS).count).toBe(1);
  });

  it('repeats every cycle and tracks progress around the ring', () => {
    expect(breathFrame(CYCLE_MS + 2500)).toEqual(breathFrame(2500));
    expect(breathFrame(CYCLE_MS / 2).cycleProgress).toBeCloseTo(0.5);
  });

  it('treats negative time as the start', () => {
    expect(breathFrame(-50)).toEqual(breathFrame(0));
  });
});

describe('formatRemaining', () => {
  it('formats minutes and padded seconds, never below zero', () => {
    expect(formatRemaining(65)).toBe('1:05');
    expect(formatRemaining(59.2)).toBe('1:00');
    expect(formatRemaining(9)).toBe('0:09');
    expect(formatRemaining(-3)).toBe('0:00');
  });
});
