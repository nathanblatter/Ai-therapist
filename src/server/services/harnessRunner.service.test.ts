// Pure-logic tests for the harness runner (ai-therapist-124): schedule
// normalization and the nightly-due decision. Process spawning is exercised
// live, not unit-tested.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), on: vi.fn() },
}));

import { normalizeSchedule, nightlyDue, extraSuiteDue, DEFAULT_SCHEDULE } from './harnessRunner.service.js';

describe('normalizeSchedule', () => {
  it('defaults an empty/garbage config safely (disabled)', () => {
    expect(normalizeSchedule(undefined)).toEqual(DEFAULT_SCHEDULE);
    expect(normalizeSchedule({ enabled: 'yes', suite: 'nope', hour_utc: 99, variations: 0 })).toEqual({
      enabled: false,
      suite: 'voice',
      hour_utc: 9,
      variations: 1,
      extra_suites: [],
    });
  });

  it('accepts a valid config', () => {
    expect(normalizeSchedule({ enabled: true, suite: 'quality', hour_utc: 3, variations: 3 })).toEqual({
      enabled: true,
      suite: 'quality',
      hour_utc: 3,
      variations: 3,
      extra_suites: [],
    });
  });

  it('keeps valid, deduplicated extra suites and never the primary itself', () => {
    expect(
      normalizeSchedule({ enabled: true, suite: 'voice', extra_suites: ['replay', 'voice', 'replay', 'bogus'] })
        .extra_suites,
    ).toEqual(['replay']);
  });
});

describe('extraSuiteDue', () => {
  const at = (iso: string) => new Date(iso);
  const sched = {
    enabled: true,
    suite: 'voice' as const,
    hour_utc: 9,
    variations: 1,
    extra_suites: ['replay' as const],
  };

  it('fires inside the window once the primary has started tonight and nothing is running', () => {
    expect(extraSuiteDue(sched, at('2026-08-15T10:40:00Z'), null, true, false)).toBe(true);
    expect(extraSuiteDue(sched, at('2026-08-15T11:59:00Z'), null, true, false)).toBe(true);
  });

  it('waits for the primary, stays out of the way of an active run, and stops after the window', () => {
    expect(extraSuiteDue(sched, at('2026-08-15T09:30:00Z'), null, false, false)).toBe(false);
    expect(extraSuiteDue(sched, at('2026-08-15T09:30:00Z'), null, true, true)).toBe(false);
    expect(extraSuiteDue(sched, at('2026-08-15T12:00:00Z'), null, true, false)).toBe(false);
    expect(extraSuiteDue({ ...sched, enabled: false }, at('2026-08-15T09:30:00Z'), null, true, false)).toBe(false);
  });

  it('debounces per suite and wraps past midnight', () => {
    expect(extraSuiteDue(sched, at('2026-08-15T10:00:00Z'), at('2026-08-15T09:50:00Z'), true, false)).toBe(false);
    const late = { ...sched, hour_utc: 23 };
    expect(extraSuiteDue(late, at('2026-08-16T01:30:00Z'), null, true, false)).toBe(true);
  });
});

describe('nightlyDue', () => {
  const at = (iso: string) => new Date(iso);
  const sched = { enabled: true, suite: 'voice' as const, hour_utc: 9, variations: 1, extra_suites: [] as never[] };

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
