// "Forget that" in the post-session job (ai-therapist-341).
//
// A participant asked the assistant to forget, erase or not remember
// something. Nothing is deleted or edited: the transcript, the SOAP note, the
// stored summary and the case profile are research data and what staff read
// (the admin participant page shows the case profile and every summary
// headline). What this module controls is only what is CARRIED FORWARD into
// session memory, through markers that staff views ignore:
//
//   1. The session the request was made in is kept out of memory whole: its
//      summary is marked memory_excluded. No model decides this. (Asking the
//      summarizer to leave the topic out, and a second model to check, still
//      let "guilt and anxiety tied to past actions" through, and the next
//      session opened with it.)
//   2. Every stored memory item OLDER than the request (remembered facts,
//      earlier summaries) is read once by checkAgainstTopics below, and the
//      ones that mention the topic are kept out of memory: a summary is marked
//      memory_excluded, a fact's id goes on the suppression row.
//   3. In LATER sessions the same check reads the new summary before it is
//      stored and marks it memory_excluded if it mentions a topic. The
//      summarizer is not told the topics, so what staff read stays a faithful
//      account of the session.
//   4. The case profile is one cumulative row that cannot be split by
//      session, so a participant who has made any forget request gets no case
//      profile in memory at all (utils/memoryScreen.ts
//      applySuppressionReadRules). It is still updated and shown to staff.
//
// It fails closed. If the check cannot run, the new summary is marked
// memory_excluded and the request stays unapplied, which makes every memory
// read hide everything older than it until a later run succeeds.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import {
  getUserMemorySuppressions,
  insertMemorySuppression,
  markMemorySuppressionsApplied,
  excludeSummariesFromMemory,
  getUserMemoriesWithDates,
  getRecentUserSummaries,
  type CaseProfile,
  type MemorySuppression,
  type SessionSummary,
} from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { looksLikeForgetRequest } from '../utils/memoryScreen.js';

const log = createLogger('memorySuppression');

const CHECK_MODEL = 'gpt-4o-mini';
const MAX_TOPICS = 20;
const MAX_DETECTED_PER_SESSION = 5;
const MAX_ITEM_CHARS = 600;

/** Distinct topics, newest first, bounded. */
export function suppressionTopics(suppressions: Array<Pick<MemorySuppression, 'topic'>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of suppressions) {
    const topic = s.topic.trim();
    const key = topic.toLowerCase();
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

export interface CheckItem {
  id: string;
  text: string;
}

/** The memory-facing text of a summary: exactly the fields promptContext and
 *  the recall tools read. */
export function summaryMemoryText(summary: SessionSummary): string {
  return [
    summary.headline,
    ...(summary.topics ?? []),
    summary.mood_trajectory,
    ...(summary.techniques_discussed ?? []),
    ...(summary.techniques_helped ?? []),
    summary.follow_up,
  ]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join(' | ');
}

const CHECK_SYSTEM_PROMPT = `You check an assistant's notes about a research participant.
The participant asked the assistant NOT to bring certain things up again (TOPICS). You are given numbered note ITEMS.
Return the id of EVERY item that mentions, refers to or alludes to any topic. That includes indirect or softened wording, a euphemism, the feelings or consequences of the thing described in a way that points at it (for a topic "what they said about cheating on a test": "guilt about academic integrity", "fear of being found out", "a secret about school" all count), and a bare statement that they regretted telling it or asked for it to be forgotten.
Items about unrelated things are not returned. When you are unsure whether an item points at a topic, return it.
Return ONLY JSON: {"flagged": ["<id>", ...]}`;

let client: OpenAI | null = null;
async function getClient(): Promise<OpenAI> {
  client ??= new OpenAI({ apiKey: await getOpenAIKey() });
  return client;
}

/**
 * Which items mention a topic. Returns null when the check could not be made
 * (API error, cut-off or unparseable reply): the caller fails closed.
 */
export async function checkAgainstTopics(
  sessionId: string,
  topics: string[],
  items: CheckItem[],
): Promise<Set<string> | null> {
  if (items.length === 0) return new Set();
  try {
    const openai = await getClient();
    const response = await openai.chat.completions.create({
      model: CHECK_MODEL,
      temperature: 0,
      max_completion_tokens: 1000,
      store: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'forget_check',
          strict: true,
          schema: {
            type: 'object',
            properties: { flagged: { type: 'array', items: { type: 'string' } } },
            required: ['flagged'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: 'system', content: CHECK_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `TOPICS:\n${topics.map((t) => `- ${t}`).join('\n')}\n\nITEMS:\n` +
            items.map((i) => `[${i.id}] ${i.text.slice(0, MAX_ITEM_CHARS)}`).join('\n'),
        },
      ],
    });
    import('../db/index.js')
      .then(({ recordLlmUsage }) =>
        recordLlmUsage(
          sessionId,
          'insights',
          CHECK_MODEL,
          response.usage?.prompt_tokens ?? null,
          response.usage?.completion_tokens ?? null,
        ),
      )
      .catch((err) => log.error({ err }, 'Failed to record LLM usage (non-fatal)'));
    const choice = response.choices[0];
    if (choice?.finish_reason !== 'stop' || !choice.message?.content) return null;
    const parsed = JSON.parse(choice.message.content) as { flagged?: unknown };
    if (!Array.isArray(parsed.flagged)) return null;
    const known = new Set(items.map((i) => i.id));
    return new Set(parsed.flagged.filter((id): id is string => typeof id === 'string' && known.has(id)));
  } catch (err) {
    log.error({ err }, `Forget check failed for ${sessionId}`);
    return null;
  }
}

export interface ForgetOutcome {
  /** The summary to store (memory_excluded set when it must not be read into memory). */
  summary: SessionSummary;
  /** The case profile to store: what the summarizer wrote, never edited. Null
   *  (leave the stored one as it is) only when a request could not be recorded. */
  caseProfile: CaseProfile | null;
  /** Call once the summary and case profile above are stored: marks the
   *  requests applied, which lifts the hide-everything-older read rule. */
  finalize: () => Promise<void>;
}

const nothingToFinalize = async (): Promise<void> => {};

const NEW_SUMMARY = 'new_summary';

/**
 * Apply the participant's forget requests to what the post-session job is
 * about to store. Called for every logged-in participant; returns its input
 * unchanged when they have never made a request.
 *
 * `check` is injectable for tests.
 */
export async function applyForgetRequests(
  input: {
    userId: number;
    sessionId: string;
    summary: SessionSummary;
    caseProfile: CaseProfile | null;
    /** The participant's own turns, joined. The summarizer's forget_requests
     *  are believed only when one of them asks for something to be forgotten. */
    participantText: string;
  },
  check: typeof checkAgainstTopics = checkAgainstTopics,
): Promise<ForgetOutcome> {
  const { userId, sessionId } = input;
  const summary: SessionSummary = { ...input.summary };
  const caseProfile = input.caseProfile;
  const detected = looksLikeForgetRequest(input.participantText)
    ? (Array.isArray(summary.forget_requests) ? summary.forget_requests : [])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .slice(0, MAX_DETECTED_PER_SESSION)
    : [];
  if (detected.length > 0) summary.forget_requests = detected;
  else delete summary.forget_requests;

  let suppressions = await getUserMemorySuppressions(userId);
  // The model did not call forget_this (or the tool is off) but the
  // summarizer saw the request in the transcript: record it now.
  if (detected.length > 0 && !suppressions.some((s) => s.session_id === sessionId)) {
    let stored = 0;
    for (const topic of detected) if (await insertMemorySuppression(userId, sessionId, topic, 'summary')) stored++;
    if (stored < detected.length) {
      // The request cannot be recorded (migration 128 not applied), so the
      // read rules cannot hide the case profile: keep this session's summary
      // out of memory and leave the stored profile as it was.
      log.warn(`Forget request in ${sessionId} could not be recorded; excluding its summary from memory`);
      return { summary: { ...summary, memory_excluded: true }, caseProfile: null, finalize: nothingToFinalize };
    }
    suppressions = await getUserMemorySuppressions(userId);
  }
  if (suppressions.length === 0) return { summary, caseProfile, finalize: nothingToFinalize };

  const topics = suppressionTopics(suppressions);
  const pending = suppressions.filter((s) => !s.applied_at);
  // The session the request was made in never reaches memory. Deterministic;
  // nothing below can undo it.
  const requestedHere = suppressions.some((s) => s.session_id === sessionId);
  if (requestedHere) summary.memory_excluded = true;
  const items: CheckItem[] = [];
  const newText = requestedHere ? '' : summaryMemoryText(summary);
  if (newText) items.push({ id: NEW_SUMMARY, text: newText });

  // Older stored memory is checked once per request, the first time the job
  // runs after it.
  if (pending.length > 0) {
    const alreadySuppressed = new Set(suppressions.flatMap((s) => s.suppressed_memory_ids ?? []));
    const [facts, summaries] = await Promise.all([
      getUserMemoriesWithDates(userId, 50),
      getRecentUserSummaries(userId, 10),
    ]);
    for (const f of facts) {
      if (f.memory_id !== undefined && !alreadySuppressed.has(f.memory_id))
        items.push({ id: `fact:${f.memory_id}`, text: f.fact });
    }
    for (const s of summaries) {
      if (s.session_id === sessionId || s.summary.incomplete || s.summary.memory_excluded) continue;
      const text = summaryMemoryText(s.summary);
      if (text) items.push({ id: `summary:${s.session_id}`, text });
    }
  }

  const flagged = await check(sessionId, topics, items);
  if (flagged === null) {
    log.error(
      { sessionId, pending: pending.length },
      `[insights] forget check unavailable for ${sessionId}; summary excluded from memory`,
    );
    return { summary: { ...summary, memory_excluded: true }, caseProfile, finalize: nothingToFinalize };
  }

  if (flagged.has(NEW_SUMMARY)) summary.memory_excluded = true;

  if (pending.length === 0) return { summary, caseProfile, finalize: nothingToFinalize };

  const ids = (prefix: string): string[] =>
    [...flagged].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  await excludeSummariesFromMemory(userId, ids('summary:'));
  const excluded = summary.memory_excluded === true;
  return {
    summary,
    caseProfile,
    finalize: async () => {
      await markMemorySuppressionsApplied(
        userId,
        pending.map((s) => s.suppression_id),
        ids('fact:')
          .map(Number)
          .filter((n) => Number.isInteger(n)),
      );
      log.info(
        `Forget request(s) applied for user ${userId}: ${flagged.size} stored item(s) kept out of memory` +
          (excluded ? ', including this session summary' : ''),
      );
    },
  };
}
