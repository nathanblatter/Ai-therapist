import { describe, it, expect } from 'vitest';
import { getNextMidnightSLC, getHoursUntilReset } from './timezoneHelpers.js';

describe('timezoneHelpers', () => {
  it('getNextMidnightSLC returns a time in the future', () => {
    const next = getNextMidnightSLC();
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('getNextMidnightSLC lands on a midnight boundary', () => {
    const next = getNextMidnightSLC();
    expect(next.getMinutes()).toBe(0);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });

  it('getHoursUntilReset is within (0, 24]', () => {
    const hours = getHoursUntilReset();
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(24);
  });
});
