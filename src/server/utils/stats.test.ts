import { describe, it, expect } from 'vitest';
import { wilsonInterval } from './stats.js';

describe('wilsonInterval', () => {
  it('returns null for n = 0', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('computes the 95% interval for 8/10', () => {
    const ci = wilsonInterval(8, 10)!;
    expect(ci.p).toBeCloseTo(0.8, 6);
    expect(ci.lo).toBeCloseTo(0.49, 2);
    expect(ci.hi).toBeCloseTo(0.943, 2);
  });

  it('symmetric 5/10 interval contains 0.5', () => {
    const ci = wilsonInterval(5, 10)!;
    expect(ci.p).toBeCloseTo(0.5, 6);
    expect(ci.lo).toBeLessThan(0.5);
    expect(ci.hi).toBeGreaterThan(0.5);
  });

  it('clamps to [0,1] at extremes', () => {
    const ci = wilsonInterval(10, 10)!;
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(ci.hi).toBeCloseTo(1, 2);
    const ci0 = wilsonInterval(0, 10)!;
    expect(ci0.lo).toBeGreaterThanOrEqual(0);
    expect(ci0.lo).toBeCloseTo(0, 2);
  });
});
