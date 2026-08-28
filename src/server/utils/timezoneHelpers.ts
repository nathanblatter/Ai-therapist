// Upcoming Denver midnight (start of TOMORROW's Denver date) as a real UTC
// instant. Built like getStartOfTodaySLC below: Denver calendar date + Denver
// UTC offset, two passes so a DST transition between now and that midnight
// (i.e. "now" is in the 00:00-02:00 window of a transition day) doesn't land
// the result an hour off — the previous wall-clock-parse implementation used
// the offset at "now" and did exactly that.
export function getNextMidnightSLC(): Date {
  const [y, m, d] = denverDateStamp().split('-').map(Number);
  const wallMidnightUtcMs = Date.UTC(y, m - 1, d + 1); // Date.UTC normalizes the day overflow
  let instant = new Date(wallMidnightUtcMs - denverOffsetMs(new Date()));
  instant = new Date(wallMidnightUtcMs - denverOffsetMs(instant));
  return instant;
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
