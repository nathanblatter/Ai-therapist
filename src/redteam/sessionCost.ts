// Session-side cost for red-team runs: what the APP spent on the sessions the
// harness drove, from the app's own usage table.
//
// Until 2026-11-18 the harness priced each chat reply at an assumed 700 input
// and 260 output tokens. Real chat calls are about 5,500 to 7,400 input tokens
// (the assembled system prompt alone is several thousand), and the work the
// app does around a session (crisis assessor during it, redaction and
// insights after /api/chat/end) was not counted at all, so reports
// under-stated chat cost by roughly six to nine times.
//
// The app already records every one of those calls in session_llm_usage with
// the token counts from the API response (chatTherapy.service.ts,
// crisisDetection.service.ts, sessionRedaction.service.ts, ...). This module
// reads those rows and books them as RECORDED. Where no count exists (a usage
// row with NULL tokens, or a reply whose row never landed) the tokens are
// ESTIMATED from the session's actual prompt length: the assembled system
// prompt stored in session_configurations plus the transcript the call saw.
//
// Post-session jobs are fire-and-forget on the server, so the cost pass runs
// once at the end of a run and waits (bounded) for their rows; a job whose row
// has not landed by then is listed as excluded rather than guessed.
//
// grok_voice and live_delegation rows are left to the voice runners, which
// price voice sessions themselves (voiceClient.ts, liveVoiceClient.ts).
import type { CostCategory, CostTracker } from './config.js';
import type { DbLike, Pipeline, Turn } from './types.js';

/** Rough characters per token for English text (OpenAI's rule of thumb). */
export const CHARS_PER_TOKEN = 4;
/** Per-message framing tokens in a chat request. */
export const MESSAGE_OVERHEAD_TOKENS = 4;
/** Output tokens assumed for one judge call (no usage is returned; reasoning
 *  tokens of a reasoning-model judge are not included). */
export const JUDGE_OUTPUT_TOKENS = 400;
/** Output tokens assumed for an in-session classifier row with no counts. */
export const IN_SESSION_OUTPUT_TOKENS = 60;

/** Jobs /api/chat/end starts for a chat session (chat.routes.ts). */
export const POST_SESSION_PURPOSES = ['redaction', 'insights'] as const;
const IN_SESSION_PURPOSES = new Set(['crisis', 'eligibility', 'rerank']);

/** Which cost category a session_llm_usage purpose belongs to; null for rows
 *  this module leaves to another runner. */
export function categoryForPurpose(purpose: string): CostCategory | null {
  if (purpose === 'chat') return 'chat-reply';
  if (IN_SESSION_PURPOSES.has(purpose)) return 'in-session';
  if ((POST_SESSION_PURPOSES as readonly string[]).includes(purpose)) return 'post-session';
  if (purpose === 'grok_voice' || purpose === 'live_delegation') return null;
  return 'other';
}

export function tokensForChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/** One judge call: system prompt + the transcript text it was sent. */
export function estimateJudgeTokens(
  systemPromptChars: number,
  transcriptChars: number,
): { inTok: number; outTok: number } {
  // ~200 chars of "Session context" framing around the transcript.
  return { inTok: tokensForChars(systemPromptChars + transcriptChars + 200), outTok: JUDGE_OUTPUT_TOKENS };
}

/**
 * Estimated tokens for each chat reply in a transcript (the server-authored
 * opening is not a model call). A reply's request carries the system prompt
 * plus every earlier message, the opening included, so input grows each turn;
 * output is the reply's actual length. Pass the tool definitions' length in
 * `systemPromptChars` too; tool-loop round trips and returning-participant
 * memory are not included, which makes this a floor.
 */
export function estimateChatTurns(
  systemPromptChars: number,
  transcript: Turn[],
): Array<{ inTok: number; outTok: number }> {
  const out: Array<{ inTok: number; outTok: number }> = [];
  let historyChars = 0;
  let messages = 1; // the system message
  for (const t of transcript) {
    if (t.role === 'assistant' && t.beatId !== 'opening') {
      out.push({
        inTok: tokensForChars(systemPromptChars + historyChars) + MESSAGE_OVERHEAD_TOKENS * messages,
        outTok: tokensForChars(t.text.length),
      });
    }
    historyChars += t.text.length;
    messages += 1;
  }
  return out;
}

/** session_llm_usage aggregated per (session, purpose, model). */
export interface UsageRow {
  session_id: string;
  purpose: string;
  model: string | null;
  /** All calls logged. */
  calls: number;
  /** Calls that carried token counts. */
  counted_calls: number;
  tokens_in: number;
  tokens_out: number;
}

export async function readSessionUsage(pool: DbLike, sessionIds: string[]): Promise<UsageRow[]> {
  if (sessionIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT session_id, purpose, model,
            COUNT(*)::int AS calls,
            COUNT(tokens_in)::int AS counted_calls,
            COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out
       FROM session_llm_usage
      WHERE session_id = ANY($1)
      GROUP BY session_id, purpose, model`,
    [sessionIds],
  );
  return rows.map((r) => ({
    session_id: String(r.session_id),
    purpose: String(r.purpose),
    model: r.model == null ? null : String(r.model),
    calls: Number(r.calls ?? 0),
    counted_calls: Number(r.counted_calls ?? 0),
    tokens_in: Number(r.tokens_in ?? 0),
    tokens_out: Number(r.tokens_out ?? 0),
  }));
}

/** Length of the assembled system prompt each session actually ran with. */
export async function readPromptChars(pool: DbLike, sessionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT session_id, LENGTH(instructions)::int AS chars FROM session_configurations WHERE session_id = ANY($1)`,
    [sessionIds],
  );
  for (const r of rows) if (r.chars != null) out.set(String(r.session_id), Number(r.chars));
  return out;
}

/** One session whose app-side spend belongs to a scenario. */
export interface SessionCostPlan {
  scenarioId: string;
  sessionId: string;
  pipeline: Pipeline;
  transcript: Turn[];
  /** Chat model the run exercised (for reply rows without a model, and for
   *  estimated replies). */
  chatModel: string;
  /** The session was ended through /api/chat/end, which starts the
   *  post-session jobs. */
  expectPostSession: boolean;
  /** The scenario's tracker; app-side lines are booked into it. */
  cost: CostTracker;
}

export interface AppliedSessionCost {
  /** Replies with no recorded usage, estimated from prompt length. */
  estimatedChatReplies: number;
  /** Usage rows without token counts, estimated from transcript length. */
  estimatedRows: number;
  /** Post-session jobs whose usage had not landed (excluded from the cost). */
  pendingPostSession: string[];
}

/**
 * Book one session's app-side usage into its scenario's tracker. Pure given
 * the rows. Recorded counts are used whenever they exist; estimates fill only
 * the gaps and are labelled as such.
 */
export function applySessionUsage(
  plan: SessionCostPlan,
  rows: UsageRow[],
  systemPromptChars: number,
): AppliedSessionCost {
  const mine = rows.filter((r) => r.session_id === plan.sessionId);
  const transcriptTokens = tokensForChars(plan.transcript.reduce((n, t) => n + t.text.length, 0));
  let recordedReplies = 0;
  let estimatedRows = 0;
  for (const r of mine) {
    const category = categoryForPurpose(r.purpose);
    if (!category) continue;
    const model = r.model ?? (category === 'chat-reply' ? plan.chatModel : 'default');
    // The post-session jobs request the flex tier (withFlex); priceTokens
    // applies it only to flex-eligible models (gpt-5 redaction, gpt-5-mini
    // leak check; not gpt-4o-mini insights).
    if (r.counted_calls > 0)
      plan.cost.addRecorded(model, r.tokens_in, r.tokens_out, category, r.counted_calls, {
        flex: category === 'post-session',
      });
    const uncounted = r.calls - r.counted_calls;
    if (category === 'chat-reply') {
      recordedReplies += r.counted_calls;
      continue; // replies without counts are estimated per turn below
    }
    if (uncounted > 0) {
      // A post-session job reads (and redaction rewrites) the whole transcript;
      // an in-session classifier reads it and answers briefly.
      const outTok = category === 'post-session' ? transcriptTokens : IN_SESSION_OUTPUT_TOKENS;
      plan.cost.estimate(model, transcriptTokens * uncounted, outTok * uncounted, category, uncounted);
      estimatedRows += uncounted;
    }
  }

  let estimatedChatReplies = 0;
  if (plan.pipeline === 'chat') {
    const turns = estimateChatTurns(systemPromptChars, plan.transcript);
    // One reply can take several model calls (tool loop), so recorded calls
    // can exceed replies; only a shortfall is estimated, from the LAST turns
    // (the ones most likely to be missing: the final fire-and-forget write, or
    // a turn cut short by an error).
    const missing = Math.max(0, turns.length - recordedReplies);
    for (const t of turns.slice(turns.length - missing)) {
      plan.cost.estimate(plan.chatModel, t.inTok, t.outTok, 'chat-reply');
    }
    estimatedChatReplies = missing;
  }

  const pendingPostSession = plan.expectPostSession
    ? POST_SESSION_PURPOSES.filter((p) => !mine.some((r) => r.purpose === p))
    : [];
  return { estimatedChatReplies, estimatedRows, pendingPostSession };
}

export interface SettleOptions {
  /** Upper bound on waiting for post-session rows (default 90 s). */
  timeoutMs?: number;
  pollMs?: number;
  /** Fallback system-prompt length when a session has no configuration row. */
  defaultPromptChars: number;
  /** Length of the JSON tool definitions sent with every chat call; added to
   *  each session's prompt for estimated replies. */
  toolSchemaChars?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SettledCost {
  sessions: number;
  waitedMs: number;
  estimatedChatReplies: number;
  estimatedRows: number;
  /** Post-session jobs excluded because their usage never landed. */
  pending: Array<{ scenarioId: string; sessionId: string; jobs: string[] }>;
}

/**
 * Wait (bounded) for every chat session's post-session jobs to log usage,
 * then book all sessions' app-side usage into their trackers. Throws on a
 * database error, before anything is booked; the caller reports it and the
 * run goes on (cost accounting must never fail a run).
 */
export async function settleSessionCosts(
  pool: DbLike,
  plans: SessionCostPlan[],
  opts: SettleOptions,
): Promise<SettledCost> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 2_000;
  const ids = [...new Set(plans.map((p) => p.sessionId))];
  const started = now();
  let rows = await readSessionUsage(pool, ids);
  const waiting = () =>
    plans.some(
      (p) =>
        p.expectPostSession &&
        POST_SESSION_PURPOSES.some((job) => !rows.some((r) => r.session_id === p.sessionId && r.purpose === job)),
    );
  while (waiting() && now() - started < timeoutMs) {
    await sleep(pollMs);
    rows = await readSessionUsage(pool, ids);
  }
  const promptChars = await readPromptChars(pool, ids);
  const out: SettledCost = {
    sessions: ids.length,
    waitedMs: now() - started,
    estimatedChatReplies: 0,
    estimatedRows: 0,
    pending: [],
  };
  for (const p of plans) {
    const prompt = (promptChars.get(p.sessionId) ?? opts.defaultPromptChars) + (opts.toolSchemaChars ?? 0);
    const applied = applySessionUsage(p, rows, prompt);
    out.estimatedChatReplies += applied.estimatedChatReplies;
    out.estimatedRows += applied.estimatedRows;
    if (applied.pendingPostSession.length) {
      out.pending.push({ scenarioId: p.scenarioId, sessionId: p.sessionId, jobs: applied.pendingPostSession });
    }
  }
  return out;
}

/** Run-level cost provenance, written to summary.json totals.cost. */
export interface RunCostNotes {
  /** session_llm_usage was read (false under --dry-run or on a DB error). */
  appUsageRead: boolean;
  postSessionWaitMs: number;
  /** Harness sessions whose post-session jobs (redaction, leak check, naming,
   *  insights) the server skipped because the scenario did not opt in
   *  (ai-therapist-383). Not run, so not billed. */
  postSessionSkipped?: number;
  /** What part of the figure is estimated, and how. */
  estimated: string[];
  /** What the figure does not include. */
  excluded: string[];
}

/** Plain-language notes for summary.json and the reports: what is estimated
 *  and what is not counted. */
export function costNotes(
  settled: SettledCost | null,
  estimatedCategories: CostCategory[],
  dryRun = false,
  postSession: { skippedSessions: number; optedIn: string[] } = { skippedSessions: 0, optedIn: [] },
): { estimated: string[]; excluded: string[] } {
  const estimated: string[] = [];
  const has = (c: CostCategory) => estimatedCategories.includes(c);
  if (has('judge'))
    estimated.push(
      'judge: the session judge returns no token usage; each call is estimated from its system prompt plus the session transcript, with a fixed 400 output tokens',
    );
  if (settled?.estimatedChatReplies)
    estimated.push(
      `chat-reply: ${settled.estimatedChatReplies} replies had no recorded usage and are estimated from the session's system prompt and transcript length`,
    );
  if (settled?.estimatedRows)
    estimated.push(
      `${settled.estimatedRows} app usage rows had no token counts and are estimated from transcript length`,
    );
  if (has('tts')) estimated.push('tts: persona speech is priced per minute of generated audio');
  if (has('assistant')) estimated.push('assistant: turns without an audit row use a fixed estimate');
  const excluded = [
    'session naming after redaction (the app does not record its usage)',
    'moderation calls (not billed)',
  ];
  if (dryRun) excluded.unshift('everything: --dry-run makes no model calls');
  else if (!settled)
    excluded.unshift(
      'app-side session usage (chat replies, crisis assessor, redaction, insights): not read in this run',
    );
  if (postSession.skippedSessions > 0)
    excluded.push(
      `post-session work (redaction, leak check, session naming, insights) was skipped for ${postSession.skippedSessions} ` +
        `harness session(s) whose scenario did not opt in: not run, so not billed` +
        (postSession.optedIn.length ? `; kept for ${postSession.optedIn.join(', ')}` : ''),
    );
  for (const p of settled?.pending ?? [])
    excluded.push(
      `${p.jobs.join(' and ')} for ${p.scenarioId} (${p.sessionId}): usage not recorded before the run ended`,
    );
  return { estimated, excluded };
}
