// Quiet hours (ai-therapist-152): the Phase 2 IRB application and consent form
// promise that the app blocks NEW sessions overnight (10:00 PM - 6:00 AM
// America/Denver) and shows crisis resources instead. This module is the pure
// policy logic; enforcement lives in middleware/quietHours.ts.
//
// Env (plain .env, off unless enabled — the study flips this on at launch):
//   QUIET_HOURS_ENABLED=true
//   QUIET_HOURS_START_HOUR / QUIET_HOURS_END_HOUR — optional overrides
//     (Denver wall-clock hours 0-23; defaults 22 and 6 per the IRB language).

export interface QuietHoursConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

const DEFAULT_START = 22;
const DEFAULT_END = 6;

function parseHour(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

export function getQuietHoursConfig(): QuietHoursConfig {
  return {
    enabled: process.env.QUIET_HOURS_ENABLED === 'true',
    startHour: parseHour(process.env.QUIET_HOURS_START_HOUR, DEFAULT_START),
    endHour: parseHour(process.env.QUIET_HOURS_END_HOUR, DEFAULT_END),
  };
}

/** Current wall-clock hour (0-23) in Denver, DST-correct via Intl. */
export function denverHour(now: Date = new Date()): number {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now);
  return Number(value);
}

/**
 * Is the given Denver hour inside the window? Overnight windows wrap
 * (start 22, end 6 => 22:00-23:59 and 00:00-05:59). start === end is treated
 * as never-active rather than always-active — a misconfiguration should fail
 * open for participants, not lock the study app around the clock.
 */
export function hourInWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function isQuietHoursActive(now: Date = new Date()): boolean {
  const { enabled, startHour, endHour } = getQuietHoursConfig();
  return enabled && hourInWindow(denverHour(now), startHour, endHour);
}

export interface QuietHoursStatus {
  enabled: boolean;
  active: boolean;
  startHour: number;
  endHour: number;
  timezone: 'America/Denver';
}

/** Shape served by GET /api/config/quiet-hours and the 403 middleware body. */
export function getQuietHoursStatus(now: Date = new Date()): QuietHoursStatus {
  const { enabled, startHour, endHour } = getQuietHoursConfig();
  return {
    enabled,
    active: enabled && hourInWindow(denverHour(now), startHour, endHour),
    startHour,
    endHour,
    timezone: 'America/Denver',
  };
}
