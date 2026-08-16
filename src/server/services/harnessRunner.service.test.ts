// Pure-logic tests for the harness runner (ai-therapist-124): schedule
// normalization and the nightly-due decision. Process spawning is exercised
// live, not unit-tested.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

import { normalizeSchedule, nightlyDue, DEFAULT_SCHEDULE } from './harnessRunner.service.js';

describe('normalizeSchedule', () => {
  it('defaults an empty/garbage config safely (disabled)', () => {
    expect(normalizeSchedule(undefined)).toEqual(DEFAULT_SCHEDULE);
    expect(normalizeSchedule({ enabled: 'yes', suite: 'nope', hour_utc: 99, variations: 0 })).toEqual({
      enabled: false, suite: 'voice', hour_utc: 9, variations: 1,
    });
  });

  it('accepts a valid config', () => {
    expect(normalizeSchedule({ enabled: true, suite: 'quality', hour_utc: 3, variations: 3 })).toEqual({
      enabled: true, suite: 'quality', hour_utc: 3, variations: 3,
    });
  });
});

describe('nightlyDue', () => {
  const at = (iso: string) => new Date(iso);
  const sched = { enabled: true, suite: 'voice' as const, hour_utc: 9, variations: 1 };

  it('fires in the scheduled UTC hour with no prior run', () => {
    expect(nightlyDue(sched, at('2026-08-15T09:12:00Z'), null, false)).toBe(true);
  });

  it('never fires when disabled, off-hour, or a run is active', () => {
    expect(nightlyDue({ ...sched, enabled: false }, at('2026-08-15T09:12:00Z'), null, false)).toBe(false);
    expect(nightlyDue(sched, at('2026-08-15T10:01:00Z'), null, false)).toBe(false);
    expect(nightlyDue(sched, at('2026-08-15T09:12:00Z'), null, true)).toBe(false);
  });

  it('debounces: no second fire within 20h of the last nightly run', () => {
    expect(nightlyDue(sched, at('2026-08-15T09:40:00Z'), at('2026-08-15T09:05:00Z'), false)).toBe(false);
    expect(nightlyDue(sched, at('2026-08-16T09:05:00Z'), at('2026-08-15T09:05:00Z'), false)).toBe(true);
  });
});
