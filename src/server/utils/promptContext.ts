// Assembles the per-participant context blocks appended to the base system
// prompt when a session starts: pre-session check-in (ai-therapist-40) and,
// for logged-in participants who opted in, cross-session memory built from
// structured end-of-session summaries (ai-therapist-39).
import {
  getRecentUserSummaries,
  countUserEndedSessions,
  getUserMemoryEnabled,
  getUserMemories,
  getUserCaseProfile,
  getUserScaleHistory,
  getUserMoodTrajectory,
  getUserLatestSafetyPlan,
  getUserLatestThoughtRecord,
  getLatestClinicianNote,
  getUserRiskContextEnabled,
  getUserPriorCrisisFlags,
  type SessionCheckin,
  type CaseProfile,
  type ScaleScorePoint,
  type MoodPoint,
  type PriorCrisisFlag,
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
 * Prompt block teaching the model when to actually CALL its client-side tools.
 * The base prompt predates tool calling — its privacy section even reads as
 * "never store anything", which made the model refuse remember_this — and
 * without explicit cues the realtime model handles most requests verbally
 * instead of invoking the matching tool (observed live: thought record asked
 * for twice and never opened, mood rating never logged, "end the session now"
 * ignored). Lines are emitted only for tools enabled for this session.
 */
export function buildToolGuidanceBlock(enabledToolNames: string[]): string {
  const has = (name: string) => enabledToolNames.includes(name);
  const lines: string[] = [];
  if (has('start_thought_record')) {
    lines.push('- When they agree to work through a thought record, CALL start_thought_record to open the on-screen form. Never walk through one only in speech.');
  }
  if (has('log_mood')) {
    lines.push('- Whenever they give a mood rating ("about a 4 out of 10"), CALL log_mood with it.');
  }
  if (has('remember_this')) {
    lines.push('- When they ask you to remember something for future conversations, CALL remember_this. You CAN store facts this way — the privacy rules above are about not repeating or leaking data, and this tool enforces the participant\'s own consent. Never claim you cannot remember things without calling it.');
  }
  if (has('recall_previous_sessions')) {
    lines.push('- When they reference past conversations, CALL recall_previous_sessions before saying you have no access.');
  }
  if (has('switch_language')) {
    lines.push('- When the conversation language changes (they ask, or start speaking another language), CALL switch_language with the new language — then continue in it.');
  }
  if (has('end_session')) {
    lines.push('- When they say they want to end and you have said goodbye, CALL end_session. Do not leave them to find the button.');
  }
  if (has('flag_notable_moment')) {
    lines.push('- When you notice a breakthrough, or a technique clearly landing or failing, silently CALL flag_notable_moment.');
  }
  if (has('start_breathing_exercise') || has('start_grounding_exercise') || has('start_body_scan')) {
    lines.push('- When they accept a breathing, grounding, or body-scan exercise, CALL the matching start_* tool so the guided visual appears — do not narrate it unaided.');
  }
  if (has('start_values_sort')) {
    lines.push('- When exploring what matters to them or they feel stuck/disconnected, offer the values card-sort and CALL start_values_sort — you\'ll get their picks back to build on.');
  }
  if (has('start_fear_ladder')) {
    lines.push('- When working on avoidance or planning exposure, offer to build a fear ladder and CALL start_fear_ladder — you\'ll get the ranked situations back.');
  }
  if (has('find_worksheet')) {
    lines.push('- When a written exercise would help, CALL find_worksheet to pick the fitting one, then call the render tool it returns (start_thought_record / show_journaling_prompt).');
  }
  if (has('review_practice')) {
    lines.push('- Early on with a returning participant, consider calling review_practice to see what they were asked to work on last time, then ask how it went.');
  }
  if (has('compare_screener_trend')) {
    lines.push('- After administer_scale finishes, CALL compare_screener_trend before commenting on the result, so you know how it compares to their last one.');
  }
  if (has('retrieve_safety_plan')) {
    lines.push('- If risk or distress rises, CALL retrieve_safety_plan to check whether they already have one before offering to build a new one.');
  }
  if (lines.length === 0) return '';
  return `\n\n## Using your tools (important)\nYour function tools show real interactive cards and forms on the participant's screen and save information for their care team. When a request matches a tool, CALL the tool — describing it verbally instead is a failure. Specifically:\n${lines.join('\n')}`;
}

/** Rolling clinical case profile block (ai-therapist-47). Compact — one line per facet. */
export function buildCaseProfileBlock(profile: CaseProfile | null): string {
  if (!profile) return '';
  const lines: string[] = [];
  if (profile.presenting_concerns?.length) lines.push(`- Presenting concerns: ${profile.presenting_concerns.join(', ')}`);
  if (profile.recurring_themes?.length) lines.push(`- Recurring themes: ${profile.recurring_themes.join(', ')}`);
  if (profile.stressors?.length) lines.push(`- Stressors: ${profile.stressors.join(', ')}`);
  if (profile.support_system?.length) lines.push(`- Support system: ${profile.support_system.join(', ')}`);
  if (profile.coping_repertoire?.length) {
    const ranked = profile.coping_repertoire.map(c => `${c.technique} (${c.helpfulness.replace('_', ' ')})`);
    lines.push(`- Coping repertoire, most helpful first: ${ranked.join(', ')}`);
  }
  if (profile.values?.length) lines.push(`- Values: ${profile.values.join(', ')}`);
  if (profile.screener_trend) lines.push(`- Screener trend: ${profile.screener_trend}`);
  if (lines.length === 0) return '';
  return `\nClinical case profile (built from all prior sessions):\n${lines.join('\n')}`;
}

/** Screener + mood + safety-plan + last-thought-record signals (ai-therapist-48). */
export function buildReturningSignalsBlock(input: {
  scaleHistory: ScaleScorePoint[];
  moodTrajectory: MoodPoint[];
  safetyPlan: { plan: { warning_signs?: string[] }; created_at: Date } | null;
  thoughtRecord: { record: { balanced_thought?: string }; created_at: Date } | null;
}): string {
  const lines: string[] = [];

  const byScale = new Map<string, ScaleScorePoint[]>();
  for (const point of input.scaleHistory) {
    const arr = byScale.get(point.scale) ?? [];
    arr.push(point);
    byScale.set(point.scale, arr);
  }
  for (const [scale, points] of byScale) {
    const [latest, prev] = points; // already newest-first, at most 2 per scale
    if (!latest) continue;
    if (prev) {
      const delta = latest.score - prev.score;
      const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';
      lines.push(`- ${scale.toUpperCase()}: ${latest.score} (was ${prev.score} — ${direction})`);
    } else {
      lines.push(`- ${scale.toUpperCase()}: ${latest.score} (first recorded)`);
    }
  }

  if (input.moodTrajectory.length > 0) {
    const chrono = [...input.moodTrajectory].reverse(); // oldest first for a readable trend
    lines.push(`- Recent mood points: ${chrono.map(p => `${p.mood}/10`).join(' -> ')}`);
  }

  if (input.safetyPlan) {
    const signs = input.safetyPlan.plan.warning_signs?.length
      ? ` (warning signs on file: ${input.safetyPlan.plan.warning_signs.join(', ')})`
      : '';
    lines.push(`- Has an existing safety plan${signs}.`);
  }

  if (input.thoughtRecord?.record.balanced_thought) {
    lines.push(`- Last thought record's balanced thought: "${input.thoughtRecord.record.balanced_thought}"`);
  }

  if (lines.length === 0) return '';
  return `\nSince their last session:\n${lines.join('\n')}`;
}

/** Private guidance a therapist left for this participant's next session (ai-therapist-50). */
export function buildClinicianNoteBlock(note: { notes: string } | null): string {
  if (!note?.notes) return '';
  return `\nGuidance from the participant's care team (private — never read this aloud or reference it explicitly):\n"${note.notes}"`;
}

/** Prior crisis-flag history — only ever built when a therapist has opted the user in (ai-therapist-52). */
export function buildRiskHistoryBlock(flags: PriorCrisisFlag[]): string {
  if (flags.length === 0) return '';
  const lines = flags.map(f => {
    const when = f.flagged_at.toISOString().slice(0, 10);
    const resolution = f.unflagged_at ? 'later resolved/unflagged' : 'no recorded resolution';
    return `- ${when}: ${f.severity ?? 'unknown'} severity (${resolution})`;
  });
  return `\nPrior risk history (a therapist has enabled sharing this — use it ONLY to check in gently, never lead with it or list it back):\n${lines.join('\n')}\nIf the conversation heads toward distress, you may check in warmly and vaguely ("how have you been holding up since we last talked?") — do not mention dates, scores, or that this history was flagged for you.`;
}

/**
 * Prompt block giving the model continuity with a returning participant.
 * Empty string for anonymous users, users who haven't opted in, or first-timers.
 */
export async function buildMemoryBlock(userId: number | null, sessionId: string | null = null): Promise<string> {
  if (!userId) return '';
  try {
    const enabled = await getUserMemoryEnabled(userId);
    if (!enabled) return '';

    const [summaries, endedCount, facts, caseProfileRow, scaleHistory, moodTrajectory, safetyPlan, thoughtRecord, clinicianNote, riskContextEnabled] = await Promise.all([
      getRecentUserSummaries(userId, 3),
      countUserEndedSessions(userId),
      getUserMemories(userId, 8),
      getUserCaseProfile(userId),
      getUserScaleHistory(userId, 2),
      getUserMoodTrajectory(userId, 6),
      getUserLatestSafetyPlan(userId),
      getUserLatestThoughtRecord(userId),
      getLatestClinicianNote(userId),
      getUserRiskContextEnabled(userId),
    ]);

    const riskFlags = riskContextEnabled ? await getUserPriorCrisisFlags(userId, sessionId, 3) : [];

    const hasAnyContext = summaries.length > 0 || facts.length > 0 || !!caseProfileRow ||
      scaleHistory.length > 0 || moodTrajectory.length > 0 || !!safetyPlan || !!thoughtRecord ||
      !!clinicianNote || riskFlags.length > 0;
    if (!hasAnyContext) return '';

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

    const factsBlock = facts.length > 0
      ? `\nThings they explicitly asked you to remember:\n${facts.map(f => `- ${f}`).join('\n')}`
      : '';
    const entriesBlock = entries.length > 0
      ? `\nContext from recent conversations, most recent first:\n${entries.join('\n')}`
      : '';
    const caseProfileBlock = buildCaseProfileBlock(caseProfileRow?.profile ?? null);
    const signalsBlock = buildReturningSignalsBlock({ scaleHistory, moodTrajectory, safetyPlan, thoughtRecord });
    const clinicianBlock = buildClinicianNoteBlock(clinicianNote);
    const riskBlock = buildRiskHistoryBlock(riskFlags);

    return `\n\n## Returning participant (conversation #${endedCount + 1} — they consented to session memory)${entriesBlock}${factsBlock}${caseProfileBlock}${signalsBlock}${clinicianBlock}${riskBlock}\nUse this for warmth and continuity ("last time we talked about..."), and to build on techniques that helped. Do not recite it back verbatim or claim to remember more than this.`;
  } catch (err) {
    // Memory must never block a session from starting.
    log.error({ err }, `Failed to build memory block for user ${userId}`);
    return '';
  }
}
