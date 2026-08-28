export function getNextMidnightSLC(): Date {
  const now = new Date();
  // Denver wall-clock "now", parsed in the host's local timezone.
  const denverWallNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Denver' }));
  // Offset between the real instant and the Denver wall-clock reading. Using the
  // offset at "now" keeps this correct regardless of the host timezone (and across
  // DST), which a bare setHours on the wall-clock value does not.
  // toLocaleString has no sub-second precision, so floor `now` to whole seconds
  // before differencing — the host↔Denver offset is whole minutes, giving a clean
  // instant (and avoiding a spurious ±1s).
  const nowFloorMs = Math.floor(now.getTime() / 1000) * 1000;
  const offsetMs = nowFloorMs - denverWallNow.getTime();
  // Next Denver midnight, expressed in Denver wall-clock terms…
  const nextMidnightWall = new Date(denverWallNow);
  nextMidnightWall.setHours(24, 0, 0, 0);
  // …converted back to a real UTC instant.
  return new Date(nextMidnightWall.getTime() + offsetMs);
}

export function getHoursUntilReset(): number {
  const now = new Date();
  const resetTime = getNextMidnightSLC();
  return (resetTime.getTime() - now.getTime()) / (1000 * 60 * 60); // hours
}

/** Today's calendar date in Denver as YYYY-MM-DD (en-CA formats exactly that). */
export function denverDateStamp(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now);
}

/** Denver's UTC offset (ms, negative) in effect at the given instant. */
function denverOffsetMs(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return -7 * 3_600_000; // MST fallback; Denver is always GMT-6/-7
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

// Start of the current day in Salt Lake City time, as a Date for created_at
// comparisons. Used to count "sessions today" for rate limiting. Built from
// the Denver calendar date + Denver UTC offset (never the host's local parse
// of a wall-clock string, which is wrong off-Denver hosts and across DST —
// see getNextMidnightSLC's offset note).
export function getStartOfTodaySLC(): Date {
  const [y, m, d] = denverDateStamp().split('-').map(Number);
  const wallMidnightUtcMs = Date.UTC(y, m - 1, d);
  // Two passes: the offset at "now" positions a candidate instant, then the
  // offset AT that candidate corrects the DST-transition-day case (midnight's
  // offset can differ from the current one).
  let instant = new Date(wallMidnightUtcMs - denverOffsetMs(new Date()));
  instant = new Date(wallMidnightUtcMs - denverOffsetMs(instant));
  return instant;
}
