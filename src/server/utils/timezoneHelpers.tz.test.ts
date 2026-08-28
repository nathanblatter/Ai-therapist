// getStartOfTodaySLC under a non-Denver host timezone. The original
// implementation parsed a Denver wall-clock string in the HOST zone and
// setHours(0)-ed it, which returned the wrong instant on any non-Denver host
// (and around DST). Forcing TZ here proves the rewrite is host-TZ-independent.
// TZ must be set before the first Date/Intl use in this file, so this lives in
// its own test file (vitest runs each file in a fresh worker).
process.env.TZ = 'Asia/Tokyo';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getStartOfTodaySLC, getNextMidnightSLC, denverDateStamp } from './timezoneHelpers.js';

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

// getNextMidnightSLC's failure window is a "now" inside 00:00-02:00 Denver on
// a DST transition day: the upcoming midnight sits across the transition, so
// deriving it from the offset at "now" (the old implementation) lands an hour
// off. These pin the exact instants on both 2026 transitions, on a non-Denver
// host so the host-TZ parse can't mask the bug.
describe('getNextMidnightSLC across DST transitions (TZ=Asia/Tokyo)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spring forward: 01:30 MST on 2026-03-08 -> next midnight is Mar 9 00:00 MDT (06:00Z)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T08:30:00Z')); // 01:30 MST, before the 02:00 jump
    expect(getNextMidnightSLC().toISOString()).toBe('2026-03-09T06:00:00.000Z');
  });

  it('fall back: 01:30 MDT on 2026-11-01 -> next midnight is Nov 2 00:00 MST (07:00Z)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T07:30:00Z')); // 01:30 MDT, first pass through the repeated hour
    expect(getNextMidnightSLC().toISOString()).toBe('2026-11-02T07:00:00.000Z');
  });

  it('ordinary day: next midnight is exactly the following Denver midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T18:00:00Z')); // 12:00 MDT
    expect(getNextMidnightSLC().toISOString()).toBe('2026-08-29T06:00:00.000Z');
  });
});
