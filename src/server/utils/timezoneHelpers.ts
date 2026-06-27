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
