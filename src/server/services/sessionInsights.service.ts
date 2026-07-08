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
  type SessionSummary,
  type SoapNote,
  type SessionCheckin,
} from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sessionInsights');

const INSIGHTS_MODEL = 'gpt-4o-mini';
const MAX_TRANSCRIPT_CHARS = 12000;

const SYSTEM_PROMPT = `You are a clinical documentation assistant for an AI-assisted therapy research study.
Given a support-conversation transcript, produce STRICT JSON with two parts:

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

Return ONLY the JSON object: {"summary": {...}, "soap": {...}}`;

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

  const client = await getClient();
  const response = await client.chat.completions.create({
    model: INSIGHTS_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 900,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${checkinLine}Transcript:\n${conversation.substring(0, MAX_TRANSCRIPT_CHARS)}` },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('Empty insights response from model');

  let parsed: { summary?: SessionSummary; soap?: SoapNote };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Insights response was not valid JSON: ${raw.substring(0, 200)}`);
  }
  if (!parsed.summary || !parsed.soap) {
    throw new Error('Insights response missing summary or soap');
  }

  await upsertSessionInsights(sessionId, session.user_id ?? null, parsed.summary, parsed.soap, INSIGHTS_MODEL);
  log.info(`Insights stored for ${sessionId} ("${parsed.summary.headline ?? ''}")`);
}

/** Fire-and-forget wrapper used by the session-end paths. */
export function generateSessionInsightsAsync(sessionId: string): void {
  generateSessionInsights(sessionId).catch(err =>
    log.error({ err }, `Failed to generate insights for ${sessionId}`));
}
