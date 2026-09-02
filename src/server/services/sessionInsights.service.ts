// Post-session insights: one LLM call per ended session producing both the
// structured memory summary (fed into the participant's future sessions when
// they've opted in — see utils/promptContext.ts) and an AI-drafted SOAP-style
// clinical note for therapist review in the admin dashboard.
//
// Runs fire-and-forget from every session-end path, alongside redaction,
// recording finalize, and session naming. Idempotent: skips sessions that
// already have insights.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import {
  getSession,
  getSessionMessages,
  getSessionInsights,
  upsertSessionInsights,
  getUserMemoryEnabled,
  getUserCaseProfile,
  upsertUserCaseProfile,
  type SessionSummary,
  type SoapNote,
  type SessionCheckin,
  type CaseProfile,
  type AffectPoint,
} from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sessionInsights');

const INSIGHTS_MODEL = 'gpt-4o-mini';
const MAX_TRANSCRIPT_CHARS = 12000;

const SYSTEM_PROMPT = `You are a clinical documentation assistant for an AI-assisted therapy research study.
Given a support-conversation transcript, produce STRICT JSON with parts:

"summary" — a compact memory of the session used to give the AI assistant continuity in this participant's FUTURE sessions. Thematic, not verbatim; never include names, places, or other identifying details.
  - headline: 3-8 words
  - topics: up to 4 short theme phrases
  - mood_trajectory: one sentence (how the participant seemed to start and end)
  - techniques_discussed: coping techniques the assistant suggested
  - techniques_helped: the subset the participant responded well to (empty array if unclear)
  - follow_up: one sentence on what a future conversation could pick up on (empty string if nothing)

"soap" — a draft SOAP note for a licensed clinician to review. Professional tone. This was a peer-support style AI conversation, not clinical treatment: keep the assessment descriptive and non-diagnostic.
  - subjective: what the participant reported (concerns, feelings, stressors)
  - objective: observable conversational behaviour (engagement, coherence, affect cues in language, session length/flow)
  - assessment: descriptive synthesis; note any risk signals or their absence; NO diagnoses
  - plan: what was suggested in-session and sensible next steps

If (and only if) a PRIOR CASE PROFILE is supplied in the user message, ALSO produce:
"case_profile" — the participant's UPDATED rolling clinical case profile, synthesizing the prior profile with this session (a MERGE, never a plain concatenation — dedupe, re-word, and drop anything superseded):
  - presenting_concerns: current short list of what brings them (up to 5)
  - recurring_themes: themes that keep coming up across sessions (up to 5)
  - stressors: current stressors (up to 5)
  - support_system: people/resources they've mentioned as support (up to 5)
  - coping_repertoire: array of {technique, helpfulness: "helped"|"mixed"|"did_not_help"}, ranked with what actually helped first (up to 6)
  - values: what they've said matters to them (up to 5)
  - screener_trend: one sentence on how any screener scores (PHQ-2/GAD-2) are trending, if mentioned; empty string if none
If no prior case profile is supplied, build a fresh one from this session alone (thin is fine).

"affect" — the participant's emotional trajectory across the session (ai-therapist-86), one entry per PARTICIPANT turn in order (if there are more than 30 participant turns, sample evenly down to about 30 entries):
  - turn: the 1-based index of that participant turn
  - valence: -1.0 (very negative) to 1.0 (very positive)
  - arousal: 0.0 (calm/flat) to 1.0 (highly activated/agitated)
  - label: ONE lowercase word for the dominant feeling (e.g. "anxious", "hopeful") — never quote the participant

Never include names, places, or other identifying details anywhere in the JSON.
Return ONLY the JSON object: {"summary": {...}, "soap": {...}, "affect": [...], "case_profile": {...}}`;

/** Validate/clamp the model's affect array (ai-therapist-86): numbers clamped
 *  to range, malformed entries dropped, sorted by turn, hard-capped at 60
 *  points, single-token labels only (a verbatim quote can't sneak through as
 *  a "label"). Returns null when nothing usable remains — affect is an
 *  optional enrichment and must never fail the insights write. */
export function sanitizeAffectCurve(raw: unknown): AffectPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const points: AffectPoint[] = [];
  for (const el of raw) {
    const p = el as { turn?: unknown; valence?: unknown; arousal?: unknown; label?: unknown };
    if (typeof p?.turn !== 'number' || !Number.isFinite(p.turn)) continue;
    if (typeof p.valence !== 'number' || !Number.isFinite(p.valence)) continue;
    if (typeof p.arousal !== 'number' || !Number.isFinite(p.arousal)) continue;
    const label = typeof p.label === 'string' ? p.label.trim().toLowerCase() : undefined;
    points.push({
      turn: Math.max(1, Math.round(p.turn)),
      valence: Math.max(-1, Math.min(1, p.valence)),
      arousal: Math.max(0, Math.min(1, p.arousal)),
      ...(label && /^[a-z-]{2,24}$/.test(label) ? { label } : {}),
    });
  }
  if (points.length === 0) return null;
  points.sort((a, b) => a.turn - b.turn);
  return points.slice(0, 60);
}

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  }
  return openaiClient;
}

export async function generateSessionInsights(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) {
    log.warn(`Session ${sessionId} not found; skipping insights`);
    return;
  }

  // Idempotency: session naming and redaction re-run safely; so does this.
  const existing = await getSessionInsights(sessionId);
  if (existing?.summary) {
    log.info(`Insights already exist for ${sessionId}; skipping`);
    return;
  }

  // Prefer original content (present at session end); fall back to the
  // redacted text for regeneration after the retention wipe has cleared it.
  const messages = await getSessionMessages(sessionId, false);
  const conversation = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, text: (m.content ?? m.content_redacted ?? '').trim() }))
    .filter(m => m.text)
    .map(m => `${m.role === 'user' ? 'Participant' : 'Assistant'}: ${m.text}`)
    .join('\n');

  if (!conversation) {
    log.info(`Session ${sessionId} has no conversation content; skipping insights`);
    return;
  }

  const checkin = (session as { checkin?: SessionCheckin | null }).checkin;
  const checkinLine = checkin
    ? `Pre-session check-in — mood: ${checkin.mood ?? 'n/a'}/10, topic: ${checkin.topic || 'n/a'}, goal: ${checkin.goal || 'n/a'}\n\n`
    : '';

  // Rolling case profile (ai-therapist-47): only participate for logged-in,
  // memory-consented users — same gate as the injected memory block itself.
  // Passing the PRIOR profile in the same LLM call lets the model MERGE
  // instead of us appending, at no extra request.
  const userId = session.user_id ?? null;
  const caseProfileEnabled = userId ? await getUserMemoryEnabled(userId) : false;
  const existingProfile = caseProfileEnabled && userId ? await getUserCaseProfile(userId) : null;
  const priorProfileLine = existingProfile
    ? `PRIOR CASE PROFILE (update/merge this):\n${JSON.stringify(existingProfile.profile)}\n\n`
    : '';

  const client = await getClient();
  const response = await client.chat.completions.create({
    model: INSIGHTS_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 1400, // affect array (ai-therapist-86) adds ~30 compact entries
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${checkinLine}${priorProfileLine}Transcript:\n${conversation.substring(0, MAX_TRANSCRIPT_CHARS)}` },
    ],
  });

  // Cost tracking (ai-therapist-25c): best-effort, never blocks insights generation.
  import('../db/index.js')
    .then(({ recordLlmUsage }) => recordLlmUsage(
      sessionId, 'insights', INSIGHTS_MODEL,
      response.usage?.prompt_tokens ?? null, response.usage?.completion_tokens ?? null,
    ))
    .catch(err => log.error({ err }, 'Failed to record LLM usage (non-fatal)'));

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('Empty insights response from model');

  let parsed: { summary?: SessionSummary; soap?: SoapNote; affect?: unknown; case_profile?: CaseProfile };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Insights response was not valid JSON: ${raw.substring(0, 200)}`);
  }
  if (!parsed.summary || !parsed.soap) {
    throw new Error('Insights response missing summary or soap');
  }

  const affectCurve = sanitizeAffectCurve(parsed.affect);
  await upsertSessionInsights(
    sessionId, session.user_id ?? null, parsed.summary, parsed.soap, INSIGHTS_MODEL, affectCurve
  );
  log.info(`Insights stored for ${sessionId} ("${parsed.summary.headline ?? ''}")`);

  if (caseProfileEnabled && userId && parsed.case_profile) {
    try {
      await upsertUserCaseProfile(userId, parsed.case_profile);
      log.info(`Case profile updated for user ${userId}`);
    } catch (err) {
      // Non-fatal: the session summary/SOAP note above is already saved.
      log.error({ err }, `Failed to update case profile for user ${userId}`);
    }
  }
}

/** Fire-and-forget wrapper used by the session-end paths. */
export function generateSessionInsightsAsync(sessionId: string): void {
  generateSessionInsights(sessionId).catch(err =>
    log.error({ err }, `Failed to generate insights for ${sessionId}`));
}
