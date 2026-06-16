export function getNextMidnightSLC(): Date {
  const nowSLC = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const nextMidnight = new Date(nowSLC);
  nextMidnight.setHours(24, 0, 0, 0); // Next midnight SLC time
  return nextMidnight;
}

export function getHoursUntilReset(): number {
  const now = new Date();
  const resetTime = getNextMidnightSLC();
  return (resetTime.getTime() - now.getTime()) / (1000 * 60 * 60); // hours
}
