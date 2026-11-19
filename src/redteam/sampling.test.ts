// Weekly sampling (sampling.ts): the calendar-week coverage guarantee, the
// nightly caps, the repeat weighting, catch-up and mid-week additions.
// Offline, pure.
import { describe, expect, it } from 'vitest';
import {
  addDays,
  CapacityError,
  DAILY_CAPS,
  isoWeek,
  mondayOf,
  nightlySample,
  planWeek,
  weekdayIndex,
  weeklyCapacity,
} from './sampling.js';
import { selectSuite, SAMPLING_PRIORITY_SCENARIOS, SMOKE_SUITE } from './scenarios/index.js';
import { CRISIS_SCENARIOS } from './scenarios/crisis/index.js';

const FULL_IDS = selectSuite('full').map((e) => e.scenario.id);
const PRIORITY = new Set(SAMPLING_PRIORITY_SCENARIOS.map((s) => s.id));
const synthetic = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/** Run the nightly for each date in turn, feeding every night's runs back as
 *  history, the way the workflow's rolling baseline does. `suiteOn(date)`
 *  lets a test change the suite mid-week; `skip` drops nights that never ran. */
function simulate(
  dates: string[],
  suiteOn: (date: string) => string[],
  priority: Set<string> = new Set(),
  skip: Set<string> = new Set(),
): Map<string, string[]> {
  const history: Record<string, string> = {};
  const runs = new Map<string, string[]>();
  for (const date of dates) {
    if (skip.has(date)) continue;
    const s = nightlySample(suiteOn(date), priority, date, { ...history });
    runs.set(date, s.run);
    for (const id of s.run) history[id] = `${date}T17:00:00.000Z`;
  }
  return runs;
}

const week = (monday: string) => Array.from({ length: 7 }, (_, d) => addDays(monday, d));

describe('dates', () => {
  it('weekday, Monday and ISO week in UTC', () => {
    expect(weekdayIndex('2026-11-16')).toBe(0); // Monday
    expect(weekdayIndex('2026-11-22')).toBe(6); // Sunday
    expect(mondayOf('2026-11-22')).toBe('2026-11-16');
    expect(isoWeek('2026-11-18')).toBe('2026-W47');
    expect(isoWeek('2027-01-01')).toBe('2026-W53'); // Friday belongs to the previous ISO year
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
  });
});

describe('weekly capacity', () => {
  it('caps are 25 Monday to Saturday and 20 on Sunday (170 a week)', () => {
    expect(DAILY_CAPS).toEqual([25, 25, 25, 25, 25, 25, 20]);
    expect(weeklyCapacity()).toBe(170);
  });

  it('the full suite fits in one week of nightly slots', () => {
    // When this fails, every scenario can no longer run once a week: raise
    // DAILY_CAPS in src/redteam/sampling.ts (a cost decision) or move
    // scenarios out of the full suite. The CLI falls back to running the whole
    // suite unsampled rather than silently dropping scenarios.
    expect(
      FULL_IDS.length,
      `full suite has ${FULL_IDS.length} scenarios, weekly capacity is ${weeklyCapacity()}: the once-a-week guarantee is impossible`,
    ).toBeLessThanOrEqual(weeklyCapacity());
  });

  it('planning over capacity throws instead of dropping scenarios', () => {
    expect(() => planWeek(synthetic(171), new Set(), '2026-11-16')).toThrow(CapacityError);
    expect(() => planWeek(synthetic(170), new Set(), '2026-11-16')).not.toThrow();
  });
});

describe('planWeek', () => {
  const sizes = [FULL_IDS.length, 7, 25, 90, 130, 169, 170];
  const mondays = Array.from({ length: 60 }, (_, i) => addDays('2026-01-05', 7 * i));

  it('assigns every scenario exactly one primary night and never exceeds a cap (60 weeks x 7 suite sizes)', () => {
    for (const n of sizes) {
      const ids = n === FULL_IDS.length ? FULL_IDS : synthetic(n);
      for (const monday of mondays) {
        const plan = planWeek(ids, PRIORITY, monday);
        const primaries = plan.primaries.flat();
        expect(primaries.sort()).toEqual([...ids].sort());
        for (let d = 0; d < 7; d++) {
          expect(plan.primaries[d].length + plan.repeats[d].length).toBeLessThanOrEqual(DAILY_CAPS[d]);
          const night = [...plan.primaries[d], ...plan.repeats[d]];
          expect(new Set(night).size).toBe(night.length); // never twice in one night
        }
      }
    }
  });

  it('fills every slot once the suite has at least a night of scenarios', () => {
    for (const ids of [FULL_IDS, synthetic(25), synthetic(130)]) {
      const plan = planWeek(ids, PRIORITY, '2026-11-16');
      for (let d = 0; d < 7; d++) expect(plan.primaries[d].length + plan.repeats[d].length).toBe(DAILY_CAPS[d]);
    }
  });

  it('is deterministic for a week and reshuffles across weeks', () => {
    const a = planWeek(FULL_IDS, PRIORITY, '2026-11-16');
    expect(planWeek(FULL_IDS, PRIORITY, '2026-11-19')).toEqual(a); // any date in the same week
    const b = planWeek(FULL_IDS, PRIORITY, '2026-11-23');
    const moved = FULL_IDS.filter((id) => a.primary[id] !== b.primary[id]).length;
    expect(moved).toBeGreaterThan(FULL_IDS.length / 2);
  });

  it('weights repeats toward the safety-critical scenarios', () => {
    const plan = planWeek(FULL_IDS, PRIORITY, '2026-11-16');
    const runs = (id: string) => 1 + plan.repeats.flat().filter((x) => x === id).length;
    const mean = (ids: string[]) => ids.reduce((n, id) => n + runs(id), 0) / ids.length;
    const critical = FULL_IDS.filter((id) => PRIORITY.has(id));
    const other = FULL_IDS.filter((id) => !PRIORITY.has(id));
    for (const id of critical) expect(runs(id)).toBeGreaterThan(1);
    expect(mean(critical)).toBeGreaterThan(mean(other));
  });
});

describe('priority set', () => {
  it('is the smoke four plus the crisis family, all in the full suite', () => {
    for (const e of SMOKE_SUITE) expect(PRIORITY.has(e.scenario.id)).toBe(true);
    for (const s of CRISIS_SCENARIOS) expect(PRIORITY.has(s.id)).toBe(true);
    for (const id of ['crisis-ladder', 'passive-ideation-indirect']) expect(PRIORITY.has(id)).toBe(true);
    const full = new Set(FULL_IDS);
    for (const id of PRIORITY) expect(full.has(id)).toBe(true);
  });
});

describe('nightlySample: the calendar-week guarantee', () => {
  const mondays = Array.from({ length: 30 }, (_, i) => addDays('2026-06-01', 7 * i));

  it('every scenario runs at least once in every Monday-to-Sunday week, nightly counts within caps', () => {
    for (const ids of [FULL_IDS, synthetic(130), synthetic(170)]) {
      for (const monday of mondays) {
        const runs = simulate(week(monday), () => ids, PRIORITY);
        const ran = new Set([...runs.values()].flat());
        expect([...ids].filter((id) => !ran.has(id))).toEqual([]);
        for (const [date, run] of runs) expect(run.length).toBeLessThanOrEqual(DAILY_CAPS[weekdayIndex(date)]);
      }
    }
  });

  it('holds across a week boundary: per calendar week, with a gap of at most 13 nights', () => {
    const dates = [...week('2026-11-16'), ...week('2026-11-23'), ...week('2026-11-30')];
    const runs = simulate(dates, () => FULL_IDS, PRIORITY);
    for (const monday of ['2026-11-16', '2026-11-23', '2026-11-30']) {
      const ran = new Set(week(monday).flatMap((d) => runs.get(d) ?? []));
      expect(FULL_IDS.filter((id) => !ran.has(id))).toEqual([]);
    }
    // The reshuffle means "every 7 consecutive nights" is NOT promised: the
    // worst case is Monday of one week to Sunday of the next.
    for (const id of FULL_IDS) {
      const nights = dates.map((d, i) => ((runs.get(d) ?? []).includes(id) ? i : -1)).filter((i) => i >= 0);
      for (let i = 1; i < nights.length; i++) expect(nights[i] - nights[i - 1]).toBeLessThanOrEqual(13);
    }
  });

  it('without history it still runs the plan (primaries cover the week)', () => {
    const ran = new Set(week('2026-11-16').flatMap((d) => nightlySample(FULL_IDS, PRIORITY, d, null).run));
    expect(FULL_IDS.filter((id) => !ran.has(id))).toEqual([]);
  });

  it('a missed night is caught up later the same week in repeat slots', () => {
    const dates = week('2026-11-16');
    const skipped = dates[2]; // Wednesday never ran
    const runs = simulate(dates, () => FULL_IDS, PRIORITY, new Set([skipped]));
    const ran = new Set([...runs.values()].flat());
    expect(FULL_IDS.filter((id) => !ran.has(id))).toEqual([]);
  });

  it("a scenario added mid-week runs before Sunday when a slot remains (today's suite and 130)", () => {
    for (const ids of [FULL_IDS, synthetic(130)]) {
      for (const monday of mondays) {
        const dates = week(monday);
        for (let addOn = 1; addOn < 7; addOn++) {
          const suiteOn = (d: string) => (d >= dates[addOn] ? [...ids, 'new-scenario'] : ids);
          const runs = simulate(dates, suiteOn, PRIORITY);
          const ran = new Set(dates.flatMap((d) => runs.get(d) ?? []));
          // Added mid-week: either its primary night is still ahead, or it is a
          // catch-up the night it appears. Existing scenarios keep their weekly
          // run even though the insertion can move their planned night.
          expect(ran.has('new-scenario')).toBe(true);
          expect(ids.filter((id) => !ran.has(id))).toEqual([]);
        }
      }
    }
    // Thousands of simulated nights: about 2 s locally, over the 5 s default on a CI runner.
  }, 30_000);

  it('at full capacity a mid-week addition that misses its night runs the following week', () => {
    const base = synthetic(169);
    const dates = [...week('2026-11-16'), ...week('2026-11-23')];
    const suiteOn = (d: string) => (d >= '2026-11-21' ? [...base, 'late'] : base); // Saturday
    const runs = simulate(dates, suiteOn);
    const nextWeek = new Set(week('2026-11-23').flatMap((d) => runs.get(d) ?? []));
    expect(nextWeek.has('late')).toBe(true);
    for (const id of base) expect(nextWeek.has(id)).toBe(true);
  });

  it('reports a next-due date for everything not run tonight', () => {
    const s = nightlySample(FULL_IDS, PRIORITY, '2026-11-18', {});
    expect(s.run.length).toBe(25);
    expect(Object.keys(s.nextDue).length).toBe(FULL_IDS.length - s.run.length);
    for (const date of Object.values(s.nextDue)) expect(date > '2026-11-18').toBe(true);
  });
});
