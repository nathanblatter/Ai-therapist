// Assembles the per-participant context blocks appended to the base system
// prompt when a session starts: pre-session check-in (ai-therapist-40) and,
// for logged-in participants who opted in, cross-session memory built from
// structured end-of-session summaries (ai-therapist-39).
import {
  getRecentUserSummaries,
  countUserEndedSessions,
  getUserMemoryEnabled,
  type SessionCheckin,
} from '../db/index.js';
import { createLogger } from './logger.js';

const log = createLogger('promptContext');

const MAX_CHECKIN_TEXT = 300;

/** Validate + normalize a client-supplied check-in body. Null if empty/invalid. */
export function sanitizeCheckin(raw: unknown): SessionCheckin | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const checkin: SessionCheckin = {};

  if (typeof input.mood === 'number' && input.mood >= 1 && input.mood <= 10) {
    checkin.mood = Math.round(input.mood);
  }
  if (typeof input.topic === 'string' && input.topic.trim()) {
    checkin.topic = input.topic.trim().substring(0, MAX_CHECKIN_TEXT);
  }
  if (typeof input.goal === 'string' && input.goal.trim()) {
    checkin.goal = input.goal.trim().substring(0, MAX_CHECKIN_TEXT);
  }

  if (checkin.mood === undefined && !checkin.topic && !checkin.goal) return null;
  checkin.submitted_at = new Date().toISOString();
  return checkin;
}

/** Prompt block for today's check-in. Empty string when there is none. */
export function buildCheckinBlock(checkin: SessionCheckin | null): string {
  if (!checkin) return '';
  const lines: string[] = [];
  if (checkin.mood !== undefined) lines.push(`- Current mood: ${checkin.mood}/10`);
  if (checkin.topic) lines.push(`- On their mind: "${checkin.topic}"`);
  if (checkin.goal) lines.push(`- What they want from today: "${checkin.goal}"`);
  return `\n\n## Today's check-in (provided by the participant just now)\n${lines.join('\n')}\nOpen the conversation by gently acknowledging this — don't interrogate them about it, just show you've heard it.`;
}

/**
 * Prompt block giving the model continuity with a returning participant.
 * Empty string for anonymous users, users who haven't opted in, or first-timers.
 */
export async function buildMemoryBlock(userId: number | null): Promise<string> {
  if (!userId) return '';
  try {
    const enabled = await getUserMemoryEnabled(userId);
    if (!enabled) return '';

    const [summaries, endedCount] = await Promise.all([
      getRecentUserSummaries(userId, 3),
      countUserEndedSessions(userId),
    ]);
    if (summaries.length === 0) return '';

    const entries = summaries.map(row => {
      const s = row.summary;
      const date = (row.ended_at ?? row.created_at).toISOString().slice(0, 10);
      const parts: string[] = [];
      if (s.topics?.length) parts.push(`topics: ${s.topics.join(', ')}`);
      if (s.mood_trajectory) parts.push(s.mood_trajectory);
      if (s.techniques_helped?.length) parts.push(`what helped: ${s.techniques_helped.join(', ')}`);
      if (s.follow_up) parts.push(`possible follow-up: ${s.follow_up}`);
      return `- ${date}${s.headline ? ` ("${s.headline}")` : ''}: ${parts.join(' | ')}`;
    });

    return `\n\n## Returning participant (conversation #${endedCount + 1} — they consented to session memory)\nContext from recent conversations, most recent first:\n${entries.join('\n')}\nUse this for warmth and continuity ("last time we talked about..."), and to build on techniques that helped. Do not recite it back verbatim or claim to remember more than this.`;
  } catch (err) {
    // Memory must never block a session from starting.
    log.error({ err }, `Failed to build memory block for user ${userId}`);
    return '';
  }
}
