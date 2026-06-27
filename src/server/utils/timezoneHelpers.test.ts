import { describe, it, expect } from 'vitest';
import { getNextMidnightSLC, getHoursUntilReset } from './timezoneHelpers.js';

describe('timezoneHelpers', () => {
  it('getNextMidnightSLC returns a time in the future', () => {
    const next = getNextMidnightSLC();
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('getNextMidnightSLC lands on midnight in Denver, regardless of host TZ', () => {
    const next = getNextMidnightSLC();
    const denver = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(next);
    // en-US renders Denver midnight as "24:00:00"; normalize to "00:00:00".
    expect(denver.replace('24:', '00:')).toBe('00:00:00');
  });

  it('getNextMidnightSLC is no more than 24h away', () => {
    const deltaHours = (getNextMidnightSLC().getTime() - Date.now()) / 3_600_000;
    expect(deltaHours).toBeLessThanOrEqual(24);
  });

  it('getHoursUntilReset is within (0, 24]', () => {
    const hours = getHoursUntilReset();
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(24);
  });
});
