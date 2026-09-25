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
  getSessionSafetyContext,
  hasSafetyContext,
  type SessionSafetyContext,
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
  - safety: REQUIRED whenever a SAFETY EVENTS block appears in the user message. One or two plain sentences naming what fired — crisis flags and their severity, escalations to a human, crisis/resource cards shown, safety plans built, adverse-event drafts — and what the participant disclosed that triggered it. Never soften or omit it, and never let the headline/mood_trajectory read as a calm session when safety events fired. Empty string ONLY when no SAFETY EVENTS block was supplied.

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

const timeOf = (at: Date | string | null): string =>
  at ? new Date(at).toISOString().slice(11, 16) : 'unknown time';

/** The SAFETY EVENTS block handed to the summarizer (ai-therapist-256).
 *  Empty string when nothing safety-relevant happened in the session. */
export function buildSafetyBlock(ctx: SessionSafetyContext): string {
  if (!hasSafetyContext(ctx)) return '';
  const lines: string[] = [];
  for (const e of ctx.crisisEvents) {
    lines.push(`- ${timeOf(e.created_at)} crisis event: ${e.event_type}${e.severity ? ` (severity: ${e.severity})` : ''}`);
  }
  for (const e of ctx.escalations) {
    const via = e.source === 'tool' ? 'escalate_to_human tool call' : 'escalation raised';
    lines.push(`- ${timeOf(e.created_at)} ${via}: ${e.reason}${e.urgency ? ` (urgency: ${e.urgency})` : ''}${e.status ? ` [${e.status}]` : ''}`);
  }
  for (const c of ctx.resourceCards) {
    lines.push(`- ${timeOf(c.created_at)} shown to participant: ${c.tool_name}${c.resource_type ? ` (${c.resource_type})` : ''}`);
  }
  for (const a of ctx.adverseEvents) {
    lines.push(`- ${timeOf(a.created_at)} adverse-event report #${a.report_id} (${a.category}, severity: ${a.severity}, ${a.status}): ${a.summary}`);
  }
  return `SAFETY EVENTS recorded during this session (these DID happen — the "safety" field is REQUIRED and the summary must reflect them):\n${lines.join('\n')}\n\n`;
}

/** Deterministic safety line, used when the model returns none despite a
 *  SAFETY EVENTS block. A reviewer must never see a summary that omits the
 *  event just because the LLM did. */
export function fallbackSafetyLine(ctx: SessionSafetyContext): string {
  const parts: string[] = [];
  const worst = ctx.crisisEvents.find(e => e.severity === 'high')?.severity
    ?? ctx.crisisEvents.find(e => e.severity)?.severity ?? null;
  if (ctx.crisisEvents.length > 0) {
    parts.push(`${ctx.crisisEvents.length} crisis event(s)${worst ? `, highest severity ${worst}` : ''}`);
  }
  if (ctx.escalations.length > 0) parts.push(`${ctx.escalations.length} escalation(s) to a human`);
  if (ctx.resourceCards.length > 0) {
    parts.push(`crisis/safety resources shown (${[...new Set(ctx.resourceCards.map(c => c.tool_name))].join(', ')})`);
  }
  if (ctx.adverseEvents.length > 0) {
    parts.push(`${ctx.adverseEvents.length} adverse-event draft(s) (#${ctx.adverseEvents.map(a => a.report_id).join(', #')})`);
  }
  return `Safety: this session recorded ${parts.join('; ')}. Review the session record.`;
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

  // Safety context (ai-therapist-256): crisis events, escalations, resource
  // cards and AE drafts from this session. Without it the summarizer sees
  // only the transcript and can miss a disclosure entirely.
  const safetyContext = await getSessionSafetyContext(sessionId);
  const safetyBlock = buildSafetyBlock(safetyContext);

  const client = await getClient();
  // Post-session job: flex halves the cost where the model supports it
  // (a no-op on gpt-4o-mini, which is not flex-eligible — see flexTier.ts).
  const { withFlex } = await import('../utils/flexTier.js');
  const response = await withFlex(INSIGHTS_MODEL, (tierParams) => client.chat.completions.create({
    model: INSIGHTS_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 1400, // affect array (ai-therapist-86) adds ~30 compact entries
    store: false,
    ...tierParams,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${checkinLine}${priorProfileLine}${safetyBlock}Transcript:\n${conversation.substring(0, MAX_TRANSCRIPT_CHARS)}` },
    ],
  }));

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

  // The safety line is not optional when safety events exist: if the model
  // skipped it (or emptied it), substitute the deterministic one.
  const summary: SessionSummary = { ...parsed.summary };
  if (hasSafetyContext(safetyContext)) {
    if (typeof summary.safety !== 'string' || !summary.safety.trim()) {
      summary.safety = fallbackSafetyLine(safetyContext);
      log.warn(`Model omitted the safety line for ${sessionId}; substituted the deterministic one`);
    }
  } else if (summary.safety !== undefined && !summary.safety.trim()) {
    delete summary.safety;
  }

  const affectCurve = sanitizeAffectCurve(parsed.affect);
  await upsertSessionInsights(
    sessionId, session.user_id ?? null, summary, parsed.soap, INSIGHTS_MODEL, affectCurve
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
