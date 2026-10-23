import { describe, it, expect } from 'vitest';
import { createOrbTracker, nextOrbState, SPEAKING_HOLD_MS } from './orbState.js';

describe('nextOrbState', () => {
  it('enters speaking immediately when the assistant level rises', () => {
    const t = createOrbTracker();
    expect(nextOrbState(t, 0, true, 0)).toBe('listening');
    expect(nextOrbState(t, 0.05, true, 16)).toBe('speaking');
  });

  it('holds speaking through short intra-turn pauses (the flicker fix)', () => {
    const t = createOrbTracker();
    nextOrbState(t, 0.05, true, 0);
    // 300 ms of silence between words: still speaking.
    for (let now = 16; now < 300; now += 16) expect(nextOrbState(t, 0, true, now)).toBe('speaking');
    // The assistant resumes: the hold clock restarts.
    expect(nextOrbState(t, 0.04, true, 316)).toBe('speaking');
    for (let now = 332; now < 316 + SPEAKING_HOLD_MS; now += 16) expect(nextOrbState(t, 0, true, now)).toBe('speaking');
  });

  it('returns to listening after a sustained silence, or idle when the mic is off', () => {
    const t = createOrbTracker();
    nextOrbState(t, 0.05, true, 0);
    expect(nextOrbState(t, 0, true, SPEAKING_HOLD_MS)).toBe('listening');
    nextOrbState(t, 0.05, false, 1000);
    expect(nextOrbState(t, 0, false, 1000 + SPEAKING_HOLD_MS)).toBe('idle');
  });

  it('uses hysteresis: a level between the off and on thresholds neither starts nor ends speaking', () => {
    const t = createOrbTracker();
    expect(nextOrbState(t, 0.015, true, 0)).toBe('listening');
    nextOrbState(t, 0.05, true, 16);
    // 0.015 is above the off-threshold, so it keeps the hold alive indefinitely.
    for (let now = 32; now < 3000; now += 16) expect(nextOrbState(t, 0.015, true, now)).toBe('speaking');
  });
});
