// Participant reflections (ai-therapist-204): the payload of GET
// /api/me/reflections, shared by the server projection and the participant
// client so the two cannot drift.
//
// This file IS the allow-list. Every field a participant can receive on this
// surface is declared here and nowhere else; the projection in
// server/utils/participantReflections.ts builds these objects field by field,
// and its test fails if the response carries any key that is not listed in
// REFLECTION_ALLOWED_KEYS or any key listed in REFLECTION_FORBIDDEN_KEYS.
// Adding a field here changes what study participants see: that is an
// IRB-relevant change, not a refactor.

/** system_config.features flag gating the whole surface. Default OFF. */
export const REFLECTIONS_FEATURE_FLAG = 'participant_reflections_enabled';

/** One ended conversation, newest first. A conversation whose reflective text
 *  is withheld (see participantReflections.ts) has empty arrays and a null
 *  check-in, exactly like a conversation that simply has no notes yet; the
 *  payload deliberately carries no marker saying which of the two it is. */
export interface ReflectionSession {
  /** When the conversation ended (ISO string on the wire). */
  date: Date | string;
  /** Short theme phrases for what the conversation was about. */
  topics: string[];
  /** Coping techniques that came up in the conversation. */
  techniques: string[];
  /** The participant's OWN pre-session check-in words, or null. */
  checkin: { topic: string | null; goal: string | null } | null;
  /** Worksheets the participant finished in this conversation. */
  worksheets_completed: number;
}

/** A SELF-REPORTED mood rating (pre-session check-in or the in-session mood
 *  log), 1-10. Model-inferred affect is never part of this surface. */
export interface ReflectionMoodPoint {
  date: Date | string;
  source: 'checkin' | 'log_mood';
  mood: number;
}

export interface ParticipantReflections {
  sessions: ReflectionSession[];
  mood: ReflectionMoodPoint[];
  worksheets: { completed: number; in_progress: number };
  continuity: {
    session_count: number;
    last_session_at: Date | string | null;
    /** Conversations per week, oldest first, zero-filled. */
    weekly_sessions: { week_start: Date | string; sessions: number }[];
  };
}

/** Every object key that may appear anywhere in the response. */
export const REFLECTION_ALLOWED_KEYS: readonly string[] = [
  'sessions',
  'mood',
  'worksheets',
  'continuity',
  // sessions[]
  'date',
  'topics',
  'techniques',
  'checkin',
  'topic',
  'goal',
  'worksheets_completed',
  // mood[]
  'source',
  // worksheets
  'completed',
  'in_progress',
  // continuity
  'session_count',
  'last_session_at',
  'weekly_sessions',
  'week_start',
];

/** Keys that must NEVER reach a participant on this surface: risk scores,
 *  crisis flags/events, the clinical SOAP note, acoustic measures, eval
 *  scores and every clinician-facing inference. Redundant with the allow-list
 *  on purpose: the list documents intent and the test names the offender. */
export const REFLECTION_FORBIDDEN_KEYS: readonly string[] = [
  // session_insights: clinician-voiced summary fields and the SOAP note
  'summary',
  'headline',
  'mood_trajectory',
  'techniques_helped',
  'follow_up',
  'safety',
  'soap',
  'soap_note',
  'soap_status',
  'soap_reviewed_by',
  'soap_reviewed_at',
  'subjective',
  'objective',
  'assessment',
  'plan',
  'notes_for_next_session',
  'notes_author',
  'notes_created_at',
  'model',
  // model-inferred affect
  'affect',
  'affect_curve',
  'valence',
  'arousal',
  'label',
  // crisis / risk
  'crisis_flagged',
  'crisis_severity',
  'crisis_risk_score',
  'crisis_flagged_at',
  'crisis_flagged_by',
  'crisis_events',
  'crisis_event_id',
  'risk_score',
  'risk_band',
  'risk_check_steps',
  'severity',
  'escalations',
  'escalation_id',
  'urgency',
  'adverse_events',
  'adverse_event_reports',
  'report_id',
  'flagged',
  'text_withheld',
  'withheld',
  // case profile and clinician notes
  'case_profile',
  'presenting_concerns',
  'recurring_themes',
  'stressors',
  'screener_trend',
  'care_notes',
  // screeners, acoustic measures, eval scores
  'scale_history',
  'score',
  'scale',
  'acoustic_features',
  'features',
  'f0_median_hz',
  'eval_scores',
  'evals',
  'ratings',
  // identifiers and transcript content this surface has no need for
  'session_id',
  'user_id',
  'session_name',
  'transcript',
  'messages',
  'content',
  'content_redacted',
];
