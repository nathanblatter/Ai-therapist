// Participant reflections projection (ai-therapist-204): turns the self-scoped
// source rows into the allow-listed payload of GET /api/me/reflections.
//
// WHY THIS IS NOT session_insights.summary VERBATIM. The summary is written by
// services/sessionInsights.service.ts under a "clinical documentation
// assistant" prompt, as memory for the AI and a catch-up read for staff. It
// speaks ABOUT the participant in the third person; `mood_trajectory` is the
// model's inference of how they "seemed"; `safety` names crisis flags and
// their severity; and when safety events fired the prompt orders the headline
// and mood_trajectory to reflect them. None of that is participant-voiced, so
// none of it is shown. This projection uses only:
//
//   - summary.topics / summary.techniques_discussed: short theme phrases and
//     the names of techniques the assistant suggested (already said to the
//     participant in-session), each screened below;
//   - the participant's OWN check-in words and SELF-REPORTED mood ratings;
//   - counts and dates.
//
// CONSERVATIVE DEFAULTS, in order:
//
//   1. A session with anything safety-relevant on record (text_withheld from
//      db/reflections.queries.ts) contributes only neutral facts: its date and
//      its completed-worksheet count. No topics, techniques or check-in words.
//   2. A session whose remaining text matches the risk/clinical lexicon below
//      is treated the same way. This catches a disclosure the crisis pipeline
//      did not flag but the summarizer still named.
//   3. A single phrase written in the staff voice ("participant's ...") is
//      dropped on its own.
//
// A withheld session is indistinguishable in the payload from one that has no
// notes yet: the response never says that something was held back, because
// that would itself disclose the flag.
import type { OwnReflectionSource, OwnReflectionSessionRow } from '../db/index.js';
import {
  REFLECTIONS_FEATURE_FLAG,
  type ParticipantReflections,
  type ReflectionSession,
} from '../../shared/reflections.js';

const MAX_TOPICS = 4;
const MAX_TECHNIQUES = 6;
const MAX_PHRASE_CHARS = 80;
const MAX_CHECKIN_CHARS = 200;

/** Risk language and clinical/diagnostic vocabulary. Any hit withholds the
 *  whole session's reflective text. Deliberately broad: a false positive costs
 *  one session's topic chips, a false negative shows a participant risk or
 *  diagnostic language about themselves. Everyday words (stress, anxiety,
 *  sadness, depression, grief) are allowed. */
const RISK_OR_CLINICAL =
  /suicid|self[-\s]?harm|self[-\s]?injur|\bkill|\bdie\b|\bdied\b|\bdying\b|\bdeath|\bdead\b|overdos|\bharm|hurt(?:ing)?\s+(?:my|him|her|them|your|one)sel|\bcrisis\b|\brisk|safety\s+plan|hotline|lifeline|\b988\b|\b911\b|emergenc|abus|assault|\brape|violen|weapon|\bguns?\b|\bcutting\b|ideation|hopeless|escalat|adverse|diagnos|disorder|symptom|patholog|clinical|bipolar|schizo|psychos|psychot|\bptsd\b|\bocd\b|\badhd\b|borderline|\bmania\b|\bmanic\b|delusion|hallucinat|relapse|comorbid|presenting\s+(?:concern|problem|issue)|prognos|treatment\s+plan|medicat|\bflagged\b|\bseverity\b/i;

/** Third-person staff voice. Drops the one phrase. */
const STAFF_VOICE = /\b(?:participant|client|patient|user|subject)(?:'s|s)?\b/i;

/** True when system_config.features turns the surface on. Strict === true:
 *  an absent, null or malformed flag means OFF. */
export function isReflectionsEnabled(config: { features?: unknown } | null | undefined): boolean {
  const features = config?.features;
  if (!features || typeof features !== 'object') return false;
  return (features as Record<string, unknown>)[REFLECTIONS_FEATURE_FLAG] === true;
}

function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

function cleanPhrases(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const el of raw) {
    const phrase = cleanText(el, MAX_PHRASE_CHARS);
    if (!phrase || STAFF_VOICE.test(phrase)) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  return phrases.slice(0, max);
}

/** One source row -> one allow-listed session. Built field by field so a
 *  widened query can never leak a column through a spread. */
export function projectReflectionSession(row: OwnReflectionSessionRow): ReflectionSession {
  const neutral: ReflectionSession = {
    date: row.session_date,
    topics: [],
    techniques: [],
    checkin: null,
    worksheets_completed: Number.isFinite(row.worksheets_completed) ? Math.max(0, row.worksheets_completed) : 0,
  };
  // Anything other than an explicit false withholds (fail closed).
  if (row.text_withheld !== false) return neutral;

  // Screen the UNTRIMMED source so a term past the display cap still counts.
  const rawText = [
    ...(Array.isArray(row.topics) ? row.topics : []),
    ...(Array.isArray(row.techniques) ? row.techniques : []),
    row.checkin_topic,
    row.checkin_goal,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' \n ');
  if (RISK_OR_CLINICAL.test(rawText)) return neutral;

  const topic = cleanText(row.checkin_topic, MAX_CHECKIN_CHARS);
  const goal = cleanText(row.checkin_goal, MAX_CHECKIN_CHARS);
  return {
    ...neutral,
    topics: cleanPhrases(row.topics, MAX_TOPICS),
    techniques: cleanPhrases(row.techniques, MAX_TECHNIQUES),
    checkin: topic || goal ? { topic, goal } : null,
  };
}

/** The whole payload. Every object is constructed explicitly from named
 *  fields; nothing from the source is spread into the response. */
export function projectReflections(source: OwnReflectionSource): ParticipantReflections {
  return {
    sessions: source.sessions.map(projectReflectionSession),
    mood: source.mood
      .filter((p) => Number.isFinite(p.mood) && (p.source === 'checkin' || p.source === 'log_mood'))
      .map((p) => ({ date: p.date, source: p.source, mood: p.mood })),
    worksheets: { completed: source.worksheets.completed, in_progress: source.worksheets.in_progress },
    continuity: {
      session_count: source.session_count,
      last_session_at: source.last_session_at,
      weekly_sessions: source.weekly_sessions.map((w) => ({ week_start: w.week_start, sessions: w.sessions })),
    },
  };
}
