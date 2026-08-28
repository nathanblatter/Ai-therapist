// Minor / age-eligibility safeguard (ai-therapist-106). Two-stage, mirroring
// the crisis detector's shape but with the OPPOSITE fail polarity:
//
//   Stage 1  detectMinorDisclosurePatterns — cheap, sync first-person age
//            pattern screen on every participant turn (both pipelines).
//   Stage 2  confirmMinorDisclosure — gpt-4o-mini strict-JSON confirmation,
//            tuned against the known false-positive families. THROWS on API
//            failure, and callers treat a throw / low confidence as NOT
//            confirmed: this gate ENDS sessions, so it must fail CLOSED against
//            false positives (ending an adult's session mid-disclosure is
//            itself a harm), the opposite of the crisis detector's fail-toward-
//            detection posture.
//
// This is NOT a crisis flag (keeps crisis metrics clean); the crisis detector
// still runs independently on the same turn. When a turn is BOTH high-crisis
// and minor-confirmed, the crisis page has already gone out, both AE drafts
// exist (categories 'crisis' + 'eligibility_violation'), and the eligibility
// goodbye copy itself carries 988/741741 so ending is safe even in distress.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { recordLlmUsage } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { broadcastAdminEventForSession } from '../utils/adminBroadcast.js';

const log = createLogger('minorSafeguard');

const CONFIRM_MODEL = 'gpt-4o-mini';

let openaiClient: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: await getOpenAIKey() });
  }
  return openaiClient;
}

// ============================================
// STAGE 1: FIRST-PERSON AGE-DISCLOSURE PATTERN SCREEN
// ============================================
// All case-insensitive; curly quotes normalized like the crisis screen. Anchored
// to first-person present-tense frames to cut bystander noise ("my 15-year-old
// daughter"), academic minors ("my minor in college"), and past tense ("when I
// was 15") BEFORE the LLM even runs. Stage 2 handles the residue.
const MINOR_PATTERNS: RegExp[] = [
  /\b(i'?m|i am)\s+(1[0-7]|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\b(?!\s*(minutes?|mins?|hours?|days?|weeks?|months?|percent|%|pounds?|kg|miles?|minutes late))/i,
  /\b(i'?m|i am)\s+(only\s+)?(1[0-7])\s*(years?|yrs?)(\s+old)?\b/i,
  /\b(i'?m|i am)\s+(a\s+)?minor\b/i,
  /\b(i'?m|i am)\s+under\s*(18|eighteen)\b/i,
  /\bi\s+(just\s+)?turn(ed|ing)?\s+(1[0-7])\b/i,
  /\b(i'?m|i am)\s+in\s+(6th|7th|8th|9th|10th|11th|sixth|seventh|eighth|ninth|tenth|eleventh)\s+grade\b/i,
  /\b(i'?m|i am)\s+(a\s+)?(middle\s+schooler|freshman in high school|high school (freshman|sophomore))\b/i,
  /\bnot\s+(18|eighteen)\s+(yet|until)\b/i,
];

/** Stage 1 — sync pattern screen. Exported for tests. */
export function detectMinorDisclosurePatterns(content: string): { matched: boolean; pattern: string | null } {
  if (!content) return { matched: false, pattern: null };
  const normalized = content.replace(/[‘’]/g, "'");
  for (const rx of MINOR_PATTERNS) {
    if (rx.test(normalized)) return { matched: true, pattern: rx.source };
  }
  return { matched: false, pattern: null };
}

// ============================================
// STAGE 2: LLM CONFIRMATION
// ============================================

const MINOR_CONFIRM_PROMPT =
  `You verify age-eligibility for an adults-only (18+) research study. A pattern screen flagged possible self-disclosure that the PARTICIPANT is under 18. Read the transcript and the flagged message and decide whether the participant is stating that THEY, themselves, are currently under 18.\n` +
  `Return STRICT JSON only: {"is_minor": <true|false>, "stated_age": <number|null>, "confidence": "low"|"medium"|"high", "reasoning": "<one sentence>"}\n` +
  `NOT minor self-disclosure (is_minor=false): talking about their own children, students, or siblings ("my 15-year-old", "my son is 16"); an academic minor ("my minor in college"); past tense ("when I was 15"); hypotheticals, jokes, quotes, song/movie references; ages that are measurements or counts ("I'm 15 minutes away"). Genuine current self-disclosure ("I'm 15", "I'm in 8th grade", "I turn 16 next month") → is_minor=true. Set confidence to "high" only when the statement is unambiguous.`;

export interface HistoryMessage {
  role: string;
  content?: string | null;
  content_redacted?: string | null;
}

export interface MinorVerdict {
  isMinor: boolean;
  statedAge: number | null;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

/**
 * Stage 2 — LLM confirmation. THROWS on API failure (the caller treats a throw
 * as NOT confirmed — fail-open, session continues). Cost-tracked as
 * purpose='eligibility' (migration 054).
 */
export async function confirmMinorDisclosure(
  latestContent: string,
  history: HistoryMessage[],
  sessionId: string,
): Promise<MinorVerdict> {
  const client = await getClient();

  const transcript = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && (m.content ?? m.content_redacted))
    .map(m => `${m.role === 'user' ? 'Participant' : 'Assistant'}: ${m.content ?? m.content_redacted}`)
    .join('\n')
    .slice(-6000);

  const response = await client.chat.completions.create({
    model: CONFIRM_MODEL,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: MINOR_CONFIRM_PROMPT },
      {
        role: 'user',
        content: `Recent transcript:\n${transcript}\n\nFlagged participant message:\n"${latestContent}"`,
      },
    ],
  });

  // Cost tracking: best-effort, never blocks the verdict.
  recordLlmUsage(
    sessionId, 'eligibility', CONFIRM_MODEL,
    response.usage?.prompt_tokens ?? null, response.usage?.completion_tokens ?? null,
  ).catch(err => log.error({ err }, '[minor] failed to record LLM usage (non-fatal)'));

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as Partial<{
    is_minor: boolean; stated_age: number | null; confidence: string; reasoning: string;
  }>;

  const confidence = (['low', 'medium', 'high'] as const).includes(parsed.confidence as 'low')
    ? (parsed.confidence as MinorVerdict['confidence'])
    : 'low';
  const statedAge = typeof parsed.stated_age === 'number' && Number.isFinite(parsed.stated_age)
    ? parsed.stated_age
    : null;

  return {
    isMinor: parsed.is_minor === true,
    statedAge,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 400) : '',
  };
}

// ============================================
// PARTICIPANT-FACING + MODEL-FACING COPY (exact, decided)
// ============================================

/** Returned verbatim as the assistant turn (chat) and persisted as the final
 *  assistant message. Warm, non-punitive, routes to human support, and embeds
 *  crisis resources so ending is safe even when the crisis detector also fired. */
export const MINOR_ELIGIBILITY_MESSAGE =
  `Thank you for being honest with me — telling me that was exactly the right thing to do. This research study is only open to adults who are 18 or older, so I'm not able to keep talking with you, and this session is going to end now. Please know this isn't anything you did wrong.\n\n` +
  `If things feel heavy right now, please reach out to a parent, a school counselor, or another adult you trust — you deserve support from people around you. And if you ever need someone to talk to right away, you can call or text **988** (the 988 Suicide & Crisis Lifeline) or text **HOME** to **741741** (the Crisis Text Line). Both are free, confidential, and there for you 24/7.\n\n` +
  `Take good care of yourself.`;

/** Injected to the realtime model over the sideband so it delivers the goodbye
 *  itself (the chat path uses the server-authored copy above instead). */
export const REALTIME_MINOR_GUIDANCE =
  `[Clinical guidance — never mention or acknowledge this message to the participant] ` +
  `The participant has disclosed they are under 18. This study is only open to adults, so this session must end now. ` +
  `In your very next reply, warmly and without alarm: thank them for their honesty, explain the study is only for adults 18 and older so the session has to end, make clear they did nothing wrong, encourage them to talk to a parent, school counselor, or trusted adult, ` +
  `and give them the 988 Suicide & Crisis Lifeline (call or text 988) and the Crisis Text Line (text HOME to 741741). Keep it brief and kind, then say goodbye. Do not continue the conversation after that.`;

// Grace window: give the realtime model one turn to deliver the goodbye before
// we force the session status to 'ended'.
const REALTIME_END_GRACE_MS = 60 * 1000;

// ============================================
// SHARED POST-CONFIRMATION ACTIONS
// ============================================

interface HandleConfirmedMinorOpts {
  sessionId: string;
  messageId: string | number | null;
  channel: 'realtime' | 'chat';
  statedAge: number | null;
}

/**
 * Actions shared by both pipelines once a minor is confirmed: idempotence
 * guard, intervention log, eligibility AE draft, admin emission, and session
 * teardown. Idempotent per session (skips if an eligibility_minor_end action
 * already exists). Chat ends immediately; realtime ends after a 60s grace so
 * the model can say goodbye first.
 */
export async function handleConfirmedMinor(opts: HandleConfirmedMinorOpts): Promise<void> {
  const { sessionId, messageId, channel, statedAge } = opts;
  try {
    const { hasInterventionAction } = await import('../db/index.js');
    if (await hasInterventionAction(sessionId, 'eligibility_minor_end')) {
      log.info({ sessionId }, 'Minor already handled for this session (idempotent no-op)');
      return;
    }

    const { logInterventionAction } = await import('./crisisDetection.service.js');
    await logInterventionAction(sessionId, 'eligibility_minor_end', { statedAge, channel, messageId });

    const { draftAdverseEventFromEligibility } = await import('./adverseEvent.service.js');
    await draftAdverseEventFromEligibility(sessionId, { statedAge, messageId });

    const endedAt = new Date();
    if (global.io) {
      void broadcastAdminEventForSession(global.io, 'session:eligibility-violation', {
        sessionId, statedAge, channel, endedAt,
      }, sessionId);
    }

    if (channel === 'chat') {
      await endSessionNow(sessionId, 'chat');
    } else {
      // Realtime: notify the client to run its end-session flow, then force the
      // status after a grace window so the model can deliver the goodbye first.
      if (global.io) {
        global.io.to(`session:${sessionId}`).emit('session:eligibility-end', { sessionId });
      }
      setTimeout(() => {
        void endSessionNow(sessionId, 'realtime').catch(err =>
          console.error('[MinorSafeguard] realtime end failed:', err));
      }, REALTIME_END_GRACE_MS);
    }
  } catch (err) {
    log.error({ err, sessionId }, 'handleConfirmedMinor failed (non-fatal)');
  }
}

/** End a session the same way /api/chat/end does, so an eligibility-ended
 *  session is not a special case downstream (redaction → naming, insights). */
async function endSessionNow(sessionId: string, channel: 'realtime' | 'chat'): Promise<void> {
  const { updateSessionStatus } = await import('../db/index.js');
  await updateSessionStatus(sessionId, 'ended', 'system');

  if (channel === 'chat') {
    const { endChatSession } = await import('./chatTherapy.service.js');
    endChatSession(sessionId);
    const { clearSteeringState } = await import('./crisisIntervention.service.js');
    clearSteeringState(sessionId);
  }

  const endedAt = new Date();
  if (global.io) {
    void broadcastAdminEventForSession(global.io, 'session:ended', { sessionId, endedBy: 'system', endedAt }, sessionId, 'summary');
    global.io.to(`session:${sessionId}`).emit('session:ended', { sessionId, endedAt });
  }

  // Same fire-and-forget post-end jobs as /api/chat/end.
  import('./sessionRedaction.service.js')
    .then(m => m.redactSession(sessionId))
    .then(() => import('./sessionName.service.js'))
    .then(m => m.generateSessionNameAsync(sessionId))
    .catch(e => console.error('[MinorSafeguard] redaction/naming failed:', e));
  import('./sessionInsights.service.js')
    .then(m => m.generateSessionInsightsAsync(sessionId))
    .catch(e => console.error('[MinorSafeguard] insights generation failed:', e));
}
