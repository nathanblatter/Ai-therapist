// The participant-facing body of every session-limit refusal (ai-therapist-324).
//
// /api/chat/start, /api/live/session and /api/grok/session each run
// checkSessionLimits and answer 429 when it says no. Before this module the
// three bodies had drifted: chat sent no message at all (the app fell back to
// a generic "try again later"), and none of them pointed to crisis resources,
// including right after a session that ended on a crisis flag. All three now
// send this one body.
//
// Wording rules: plain and non-alarming. Someone hitting the cooldown is
// usually just between sessions, not in crisis, so the resources are offered
// ("if you would like support before then"), never implied to be needed, and
// nothing here claims anyone was told or will reach out.
import { DEFAULT_CRISIS_CONTACT, type OpeningCrisisContact } from '../../shared/openingPrompt.js';
import { getSystemConfig, type SessionLimitResult } from './sessionHelpers.js';

export type SessionLimitDenied = Extract<SessionLimitResult, { allowed: false }>;

export interface SessionLimitCrisisResources {
  hotline: string;
  phone: string;
  text: string;
}

export interface SessionLimitRefusalBody {
  error: 'rate_limit_exceeded';
  reason: SessionLimitDenied['reason'] | 'too_many_attempts';
  /** Complete participant-readable text: when they can return, then the resources. */
  message: string;
  /** Just the "when" sentence, for a screen that lists the resources itself. */
  retry_message: string;
  minutes_remaining?: number;
  details: {
    limit?: number;
    current?: number;
    cooldown_minutes?: number;
    minutes_remaining?: number;
  };
  crisis_resources: SessionLimitCrisisResources;
}

/** "28 minutes", "1 minute", "1 hour", "2 hours and 5 minutes". */
export function formatWait(minutes: number): string {
  const m = Math.max(1, Math.ceil(minutes));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (m < 60) return unit(m, 'minute');
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} and ${unit(rest, 'minute')}`;
}

/**
 * The configured crisis contact (system_config.crisis_contact, the same one
 * the prompt and GET /api/config/crisis use). A disabled or incomplete entry
 * falls back to the shared defaults rather than dropping the resources: a
 * limit refusal must always carry them.
 */
export function resolveCrisisResources(contact: OpeningCrisisContact | null | undefined): SessionLimitCrisisResources {
  const usable = contact && contact.enabled !== false && contact.hotline && contact.phone;
  const c = usable ? contact : DEFAULT_CRISIS_CONTACT;
  return {
    hotline: c.hotline as string,
    phone: c.phone as string,
    text: (usable ? contact.text : DEFAULT_CRISIS_CONTACT.text) ?? '',
  };
}

/** "If you would like support before then, ..." built from the crisis contact. */
export function crisisResourcesSentence(r: SessionLimitCrisisResources): string {
  const text = r.text ? `, or ${r.text.charAt(0).toLowerCase()}${r.text.slice(1)}` : '';
  return `If you would like support before then, you can reach the ${r.hotline} any time at ${r.phone}${text}.`;
}

/** The "when can I come back" sentence for each refusal reason. */
export function retrySentence(limit: SessionLimitDenied): string {
  if (limit.reason === 'cooldown') {
    return `You can start your next session in ${formatWait(limit.minutes_remaining)}. There is a short break between sessions for everyone in the study.`;
  }
  return `You have used today's ${limit.limit} session${limit.limit === 1 ? '' : 's'}. You can start a new one tomorrow.`;
}

export function buildSessionLimitRefusal(
  limit: SessionLimitDenied,
  contact: OpeningCrisisContact | null | undefined,
): SessionLimitRefusalBody {
  const resources = resolveCrisisResources(contact);
  const retry = retrySentence(limit);
  const cooldown = limit.reason === 'cooldown' ? limit : null;
  const daily = limit.reason === 'daily_limit' ? limit : null;
  return {
    error: 'rate_limit_exceeded',
    reason: limit.reason,
    message: `${retry} ${crisisResourcesSentence(resources)}`,
    retry_message: retry,
    // Top level as well as under details: the chat client and the GATE-05
    // scenario have always read it there.
    minutes_remaining: cooldown?.minutes_remaining,
    details: {
      limit: daily?.limit,
      current: daily?.current,
      cooldown_minutes: cooldown?.cooldown_minutes,
      minutes_remaining: cooldown?.minutes_remaining,
    },
    crisis_resources: resources,
  };
}

/**
 * The same shape for the per-IP start backstop on /api/chat/start (a shared
 * address such as a dorm network can trip it), so the app never shows a bare
 * "Too many requests" with no resources.
 */
export function buildTooManyAttemptsRefusal(contact: OpeningCrisisContact | null | undefined): SessionLimitRefusalBody {
  const resources = resolveCrisisResources(contact);
  const retry = 'Too many sessions have been started from this network recently. Please try again in about 15 minutes.';
  return {
    error: 'rate_limit_exceeded',
    reason: 'too_many_attempts',
    message: `${retry} ${crisisResourcesSentence(resources)}`,
    retry_message: retry,
    details: {},
    crisis_resources: resources,
  };
}

/** The configured crisis contact, or null (the builders then use the defaults). */
async function configuredCrisisContact(): Promise<OpeningCrisisContact | null> {
  try {
    const config = await getSystemConfig();
    return (config.crisis_contact as OpeningCrisisContact | undefined) ?? null;
  } catch {
    return null;
  }
}

/** buildSessionLimitRefusal with the configured crisis contact: what the start routes send. */
export async function sessionLimitRefusalFor(limit: SessionLimitDenied): Promise<SessionLimitRefusalBody> {
  return buildSessionLimitRefusal(limit, await configuredCrisisContact());
}

/** buildTooManyAttemptsRefusal with the configured crisis contact. */
export async function tooManyAttemptsRefusal(): Promise<SessionLimitRefusalBody> {
  return buildTooManyAttemptsRefusal(await configuredCrisisContact());
}
