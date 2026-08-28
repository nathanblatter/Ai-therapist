// getStartOfTodaySLC under a non-Denver host timezone. The original
// implementation parsed a Denver wall-clock string in the HOST zone and
// setHours(0)-ed it, which returned the wrong instant on any non-Denver host
// (and around DST). Forcing TZ here proves the rewrite is host-TZ-independent.
// TZ must be set before the first Date/Intl use in this file, so this lives in
// its own test file (vitest runs each file in a fresh worker).
process.env.TZ = 'Asia/Tokyo';

import { describe, it, expect } from 'vitest';
import { getStartOfTodaySLC, denverDateStamp } from './timezoneHelpers.js';

describe('getStartOfTodaySLC on a non-Denver host (TZ=Asia/Tokyo)', () => {
  it('host timezone is actually Tokyo (guard for the test setup itself)', () => {
    expect(new Date().getTimezoneOffset()).toBe(-540);
  });

  it('returns the UTC instant of Denver midnight, not host midnight', () => {
    const start = getStartOfTodaySLC();
    const denver = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(start);
    expect(denver.replace('24:', '00:')).toBe('00:00:00');
    expect(denverDateStamp(start)).toBe(denverDateStamp());
    expect(start.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - start.getTime()).toBeLessThanOrEqual(25 * 3_600_000);
  });
});
