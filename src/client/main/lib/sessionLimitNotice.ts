/**
 * What the app shows when a session start is refused for a session limit
 * (HTTP 429 from /api/chat/start, /api/live/session or /api/grok/session).
 *
 * The server sends one body for all three routes (ai-therapist-324,
 * server/utils/sessionLimitRefusal.ts): `retry_message` says when they can
 * start again, `message` adds the crisis resources sentence. The screen lists
 * the resources itself, so it prefers `retry_message`. Older or unexpected
 * bodies (or a body that was not JSON) still get a plain sentence.
 */
export type SessionLimitReason = 'cooldown' | 'daily_limit' | 'too_many_attempts' | 'unknown';

export interface SessionLimitNotice {
  reason: SessionLimitReason;
  /** The "when can I start again" text. Never empty. */
  retryText: string;
}

const FALLBACK = 'You cannot start a new session right now. Please try again a little later.';

export function sessionLimitNotice(body: unknown): SessionLimitNotice {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const reason: SessionLimitReason =
    b.reason === 'cooldown' || b.reason === 'daily_limit' || b.reason === 'too_many_attempts' ? b.reason : 'unknown';
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const minutes = typeof b.minutes_remaining === 'number' && b.minutes_remaining > 0 ? b.minutes_remaining : null;
  const derived =
    reason === 'cooldown' && minutes
      ? `You can start your next session in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      : reason === 'daily_limit'
        ? "You have used today's sessions. You can start a new one tomorrow."
        : null;
  return { reason, retryText: pick(b.retry_message) ?? derived ?? pick(b.message) ?? FALLBACK };
}

/** Title for the refusal screen. Plain, not alarming. */
export function sessionLimitTitle(reason: SessionLimitReason): string {
  switch (reason) {
    case 'cooldown':
      return 'Your next session opens soon';
    case 'daily_limit':
      return "You have reached today's session limit";
    default:
      return 'Sessions are paused for a moment';
  }
}
