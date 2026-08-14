// Shared per-participant clinical/memory bundle (ai-therapist-110).
//
// This is the single fan-out behind BOTH consumers of "what the system knows
// about this participant":
//   - utils/promptContext.ts buildMemoryBlock (the block injected into the AI
//     prompt at session start), and
//   - routes/admin/participantProfile.routes.ts (the therapist-facing
//     participant profile page).
// Keeping one composition function means the admin view can never drift from
// what the AI actually sees.
import { pool } from '../config/db.js';
import {
  getRecentUserSummaries,
  countUserEndedSessions,
  getUserMemoryEnabled,
  getLatestClinicianNote,
  type UserSummaryRow,
  type ClinicianNote,
} from './insights.queries.js';
import { getUserMemoriesWithDates, type UserMemoryFact, type SafetyPlan } from './tools.queries.js';
import { getUserCaseProfile, type UserCaseProfileRow } from './caseProfile.queries.js';
import {
  getUserScaleHistory,
  getUserMoodTrajectory,
  getUserLatestSafetyPlan,
  getUserLatestThoughtRecord,
  type ScaleScorePoint,
  type MoodPoint,
  type ThoughtRecordEntry,
} from './returningContext.queries.js';
import {
  getUserRiskContextEnabled,
  getUserPriorCrisisFlags,
  type PriorCrisisFlag,
} from './crisis.queries.js';

export interface ParticipantProfileBundle {
  /** Participant's own memory-consent flag. */
  memory_enabled: boolean;
  /** Therapist-controlled opt-in for sharing prior crisis history with the AI. */
  risk_context_share_enabled: boolean;
  /** Structured end-of-session summaries, most recent first. */
  summaries: UserSummaryRow[];
  ended_session_count: number;
  /** Facts the participant explicitly asked the AI to remember, with dates. */
  memories: UserMemoryFact[];
  case_profile: UserCaseProfileRow | null;
  /** PHQ-2/GAD-2 responses, most recent first within each scale. */
  scale_history: ScaleScorePoint[];
  /** Check-in / log_mood points, newest first. */
  mood_trajectory: MoodPoint[];
  safety_plan: { plan: SafetyPlan; created_at: Date; session_id: string | null } | null;
  thought_record: { record: ThoughtRecordEntry; created_at: Date } | null;
  clinician_note: ClinicianNote | null;
  /** Empty unless risk_context_share_enabled — mirrors what the AI is allowed to see. */
  prior_crisis_flags: PriorCrisisFlag[];
}

export interface ProfileBundleOptions {
  /** Session to exclude from prior-crisis-flag history (the one being started). */
  sessionId?: string | null;
  summariesLimit?: number;
  memoriesLimit?: number;
  /** Responses kept per scale (2 = prompt trend; higher = admin charts). */
  scalePerScale?: number;
  moodLimit?: number;
  crisisFlagsLimit?: number;
}

// Admin-view defaults: generous enough for charts and timelines. The prompt
// path (buildMemoryBlock) passes its own tighter limits explicitly.
const DEFAULTS: Required<Omit<ProfileBundleOptions, 'sessionId'>> = {
  summariesLimit: 10,
  memoriesLimit: 50,
  scalePerScale: 12,
  moodLimit: 30,
  crisisFlagsLimit: 10,
};

/** Everything the system remembers about one participant, fetched in parallel. */
export async function getUserProfileBundle(
  userId: number,
  options: ProfileBundleOptions = {}
): Promise<ParticipantProfileBundle> {
  const opts = { ...DEFAULTS, ...options };
  const sessionId = options.sessionId ?? null;

  const [
    memoryEnabled,
    summaries,
    endedCount,
    memories,
    caseProfile,
    scaleHistory,
    moodTrajectory,
    safetyPlan,
    thoughtRecord,
    clinicianNote,
    riskContextEnabled,
  ] = await Promise.all([
    getUserMemoryEnabled(userId),
    getRecentUserSummaries(userId, opts.summariesLimit),
    countUserEndedSessions(userId),
    getUserMemoriesWithDates(userId, opts.memoriesLimit),
    getUserCaseProfile(userId),
    getUserScaleHistory(userId, opts.scalePerScale),
    getUserMoodTrajectory(userId, opts.moodLimit),
    getUserLatestSafetyPlan(userId),
    getUserLatestThoughtRecord(userId),
    getLatestClinicianNote(userId),
    getUserRiskContextEnabled(userId),
  ]);

  // Prior crisis history is only ever materialized when a therapist has opted
  // this user in — the same consent gate the prompt path applies.
  const priorCrisisFlags = riskContextEnabled
    ? await getUserPriorCrisisFlags(userId, sessionId, opts.crisisFlagsLimit)
    : [];

  return {
    memory_enabled: memoryEnabled,
    risk_context_share_enabled: riskContextEnabled,
    summaries,
    ended_session_count: endedCount,
    memories,
    case_profile: caseProfile,
    scale_history: scaleHistory,
    mood_trajectory: moodTrajectory,
    safety_plan: safetyPlan,
    thought_record: thoughtRecord,
    clinician_note: clinicianNote,
    prior_crisis_flags: priorCrisisFlags,
  };
}

export interface SessionScoreExtras {
  session_id: string;
  /** Mean of the latest eval's rubric dimension scores, or null if unevaluated. */
  eval_score: number | null;
  /** Participant's helpfulness rating (1-5), or null if no feedback. */
  feedback_rating: number | null;
}

/**
 * Eval score + feedback rating for a page of sessions (participant profile
 * session-history table). One batched query instead of joining these onto the
 * main admin session list.
 */
export async function getSessionScoreExtras(sessionIds: string[]): Promise<SessionScoreExtras[]> {
  if (sessionIds.length === 0) return [];
  const result = await pool.query<{ session_id: string; rubric: Record<string, { score?: number }> | null; helpfulness_rating: number | null }>(
    `SELECT s.session_id,
            e.rubric,
            f.helpfulness_rating
     FROM unnest($1::text[]) AS s(session_id)
     LEFT JOIN LATERAL (
       SELECT rubric FROM session_evals se
       WHERE se.session_id = s.session_id
       ORDER BY se.created_at DESC
       LIMIT 1
     ) e ON TRUE
     LEFT JOIN session_feedback f ON f.session_id = s.session_id`,
    [sessionIds]
  );
  return result.rows.map(row => {
    let evalScore: number | null = null;
    if (row.rubric) {
      const scores = Object.values(row.rubric)
        .map(d => (typeof d?.score === 'number' ? d.score : null))
        .filter((s): s is number => s !== null);
      if (scores.length > 0) {
        evalScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
      }
    }
    return { session_id: row.session_id, eval_score: evalScore, feedback_rating: row.helpfulness_rating };
  });
}
