export function getNextMidnightSLC() {
  const nowSLC = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const nextMidnight = new Date(nowSLC);
  nextMidnight.setHours(24, 0, 0, 0); // Next midnight SLC time
  return nextMidnight;
}

export function getHoursUntilReset() {
  const now = new Date();
  const resetTime = getNextMidnightSLC();
  return (resetTime - now) / (1000 * 60 * 60); // hours
}
