// Weekly sampling for the nightly full suite (owner decision 2026-11-18): the
// nightly runs a capped sample instead of every scenario, and EVERY scenario in
// the suite still runs at least once per calendar week (Monday to Sunday UTC).
//
// How a week is planned (pure, deterministic, unit-tested in sampling.test.ts):
//   1. Primary night. Every scenario gets exactly one night of the ISO week,
//      chosen from its own seeded preference order over the seven days (the
//      seed is the ISO week, so assignments reshuffle week to week). A night
//      that has reached its cap is skipped, so primaries never exceed a cap;
//      since the suite never exceeds the weekly capacity, every scenario finds
//      a night. Coverage therefore holds by construction.
//   2. Repeats. The slots left on each night are filled with extra runs,
//      weighted 3 to 1 toward the safety-critical scenarios (the smoke four and
//      the crisis family), at most once per scenario per night.
//   3. Catch-up (at run time, needs the previous night's results). A scenario
//      whose primary night has passed this week without a recorded run (a night
//      did not run, or the scenario was added or moved mid-week) takes a repeat
//      slot tonight; if no slot is left it is deferred to the next night, and
//      failing that it runs in the following week.
//
// The weekly guarantee is per calendar week, not per 7 consecutive nights: the
// weekly reshuffle can put a scenario on Monday one week and on Sunday the
// next, a gap of 13 nights. A strict every-7-nights guarantee with one run a
// week requires a fixed weekday per scenario, which the owner traded for the
// reshuffle.

/** Scenario runs per night, Monday (index 0) to Sunday (index 6). The one
 *  place the caps live; the capacity test in sampling.test.ts reads them. */
export const DAILY_CAPS: readonly number[] = [25, 25, 25, 25, 25, 25, 20];

/** Repeat weighting: a safety-critical scenario earns this many repeats per
 *  repeat of any other scenario. */
export const PRIORITY_REPEAT_WEIGHT = 3;

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weeklyCapacity(caps: readonly number[] = DAILY_CAPS): number {
  return caps.reduce((a, b) => a + b, 0);
}

export class CapacityError extends Error {}

/** FNV-1a 32-bit with a final avalanche; stable across platforms and runs. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date "${date}" (want YYYY-MM-DD)`);
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`invalid date "${date}"`);
  return t;
}

function fmt(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return fmt(parseDate(date) + n * DAY_MS);
}

/** UTC weekday index, Monday = 0 ... Sunday = 6. */
export function weekdayIndex(date: string): number {
  return (new Date(parseDate(date)).getUTCDay() + 6) % 7;
}

export function mondayOf(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

/** ISO 8601 week label, e.g. 2026-W47 (the week's Thursday decides the year). */
export function isoWeek(date: string): string {
  const thursday = parseDate(addDays(mondayOf(date), 3));
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday - jan1) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface WeekPlan {
  week: string;
  /** Monday's date, YYYY-MM-DD. */
  monday: string;
  caps: number[];
  /** Scenario id -> primary night (0 = Monday). */
  primary: Record<string, number>;
  /** Per night: primary scenario ids, then repeat ids (repeats in priority order). */
  primaries: string[][];
  repeats: string[][];
}

/** Plan one ISO week for these scenario ids. Throws CapacityError when the
 *  suite exceeds the weekly capacity (the guarantee would be impossible). */
export function planWeek(
  ids: readonly string[],
  priority: ReadonlySet<string>,
  date: string,
  caps: readonly number[] = DAILY_CAPS,
): WeekPlan {
  if (caps.length !== 7) throw new Error('caps must list 7 nights, Monday to Sunday');
  const unique = [...new Set(ids)];
  const capacity = weeklyCapacity(caps);
  if (unique.length > capacity)
    throw new CapacityError(
      `${unique.length} scenarios exceed the weekly capacity of ${capacity} runs (caps ${caps.join('/')}): ` +
        'every scenario can no longer run once a week. Raise DAILY_CAPS in src/redteam/sampling.ts or move scenarios out of the suite.',
    );
  const monday = mondayOf(date);
  const week = isoWeek(date);
  const h = (...parts: Array<string | number>) => stableHash([week, ...parts].join('|'));

  // 1. Primary nights: seeded scenario order, seeded day preference each.
  const orderKey = new Map(unique.map((id) => [id, h(id)]));
  const order = [...unique].sort((a, b) => orderKey.get(a)! - orderKey.get(b)! || (a < b ? -1 : 1));
  const primaries: string[][] = caps.map(() => []);
  const primary: Record<string, number> = {};
  for (const id of order) {
    const dayKey = [0, 1, 2, 3, 4, 5, 6].map((d) => h(id, d));
    const prefs = [0, 1, 2, 3, 4, 5, 6].sort((x, y) => dayKey[x] - dayKey[y] || x - y);
    const day = prefs.find((d) => primaries[d].length < caps[d]);
    if (day === undefined) throw new CapacityError('no night with a free slot (unreachable when within capacity)');
    primaries[day].push(id);
    primary[id] = day;
  }

  // 2. Repeats: weighted round-robin (lowest (repeats+1)/weight first), each
  // placed on the night with the most free slots that does not already run it.
  const runsOn = new Map<string, Set<number>>(unique.map((id) => [id, new Set([primary[id]])]));
  const free = caps.map((c, d) => c - primaries[d].length);
  const repeats: string[][] = caps.map(() => []);
  const count = new Map<string, number>(unique.map((id) => [id, 0]));
  const weight = (id: string) => (priority.has(id) ? PRIORITY_REPEAT_WEIGHT : 1);
  const repeatKey = new Map(unique.map((id) => [id, h('r', id)]));
  const placeable = (id: string) => free.some((f, d) => f > 0 && !runsOn.get(id)!.has(d));
  for (;;) {
    // Next repeat: the lowest (repeats + 1) / weight, ties by a seeded key.
    let id: string | null = null;
    let best = Infinity;
    for (const c of unique) {
      const score = (count.get(c)! + 1) / weight(c);
      if (score > best || (score === best && repeatKey.get(c)! > repeatKey.get(id!)!)) continue;
      if (!placeable(c)) continue;
      id = c;
      best = score;
    }
    if (id === null) break;
    const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => free[d] > 0 && !runsOn.get(id)!.has(d));
    const n = count.get(id)!;
    days.sort((x, y) => free[y] - free[x] || h('d', id, n, x) - h('d', id, n, y));
    const day = days[0];
    repeats[day].push(id);
    runsOn.get(id)!.add(day);
    free[day]--;
    count.set(id, count.get(id)! + 1);
  }
  return { week, monday, caps: [...caps], primary, primaries, repeats };
}

export interface NightlySample {
  date: string;
  week: string;
  weekday: number;
  cap: number;
  /** Ids to run tonight, in suite order. */
  run: string[];
  primaries: string[];
  catchUp: string[];
  repeats: string[];
  /** Missed this week but no slot left tonight; they get the next night's repeat slots. */
  deferred: string[];
  /** Whether previous results were available to drive catch-up. */
  historyAvailable: boolean;
  total: number;
  /** Not run tonight -> next date the plan runs it (this week or next). */
  nextDue: Record<string, string>;
}

/**
 * Tonight's sample. `history` maps scenario id -> ISO timestamp of its most
 * recent recorded run (the previous night's rolling-baseline.json); null when
 * no earlier results were found, which turns catch-up off.
 */
export function nightlySample(
  ids: readonly string[],
  priority: ReadonlySet<string>,
  date: string,
  history: Readonly<Record<string, string>> | null,
  caps: readonly number[] = DAILY_CAPS,
): NightlySample {
  const plan = planWeek(ids, priority, date, caps);
  const t = weekdayIndex(date);
  const weekStart = parseDate(plan.monday);
  const tonight = parseDate(date);
  const ranThisWeek = (id: string) => {
    const at = history?.[id] ? Date.parse(history[id]) : NaN;
    return !Number.isNaN(at) && at >= weekStart && at < tonight;
  };
  // A primary that already ran this week (as a repeat or a catch-up) has met
  // its weekly run, so it yields its slot to a missed scenario like a repeat.
  const primaries = plan.primaries[t].filter((id) => !ranThisWeek(id));
  const alreadyRan = plan.primaries[t].filter((id) => ranThisWeek(id));
  const slots = caps[t] - primaries.length;
  const tie = (a: string, b: string) =>
    Number(priority.has(b)) - Number(priority.has(a)) ||
    stableHash(`${plan.week}|c|${a}`) - stableHash(`${plan.week}|c|${b}`);
  const missed = history ? ids.filter((id) => plan.primary[id] < t && !ranThisWeek(id)).sort(tie) : [];
  const catchUp = missed.slice(0, slots);
  const deferred = missed.slice(slots);
  const taken = new Set([...primaries, ...catchUp]);
  const repeats = [...new Set([...alreadyRan, ...plan.repeats[t]])]
    .filter((id) => !taken.has(id))
    .slice(0, slots - catchUp.length);
  const runSet = new Set([...taken, ...repeats]);
  const run = [...new Set(ids)].filter((id) => runSet.has(id));

  const next = planWeek(ids, priority, addDays(plan.monday, 7), caps);
  const nextDue: Record<string, string> = {};
  for (const id of new Set(ids)) {
    if (runSet.has(id)) continue;
    let due: string | null = null;
    for (let d = t + 1; d < 7 && !due; d++)
      if (plan.primaries[d].includes(id) || plan.repeats[d].includes(id)) due = addDays(plan.monday, d);
    for (let d = 0; d < 7 && !due; d++)
      if (next.primaries[d].includes(id) || next.repeats[d].includes(id)) due = addDays(next.monday, d);
    // A deferred catch-up runs on the next night with a free repeat slot.
    if (deferred.includes(id) && t < 6) due = addDays(date, 1);
    nextDue[id] = due ?? addDays(next.monday, 7);
  }
  return {
    date,
    week: plan.week,
    weekday: t,
    cap: caps[t],
    run,
    primaries: [...primaries],
    catchUp,
    repeats,
    deferred,
    historyAvailable: history !== null,
    total: new Set(ids).size,
    nextDue,
  };
}

/** UTC date (YYYY-MM-DD) of a Date. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
