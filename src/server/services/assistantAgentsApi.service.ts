// Opt-in OpenAI Agents API backend for the admin assistant
// (features.assistant_agents_api_enabled, default OFF; decision record in
// docs/agents-api-evaluation.md). Loaded by assistant.service.ts only when the
// flag is on.
//
// Why this backend is deliberately narrow. The stateless backend calls
// /v1/responses with store:false: OpenAI keeps no application state and only
// the 30-day abuse-monitoring copy the consent materials already disclose.
// The Agents API has no store:false: per OpenAI's data-controls table,
// /v1/agents keeps application state "Until deleted", is not Zero Data
// Retention eligible, and session deletion only promises that "physical
// cleanup may continue asynchronously". Session items include tool results.
// So on this path:
//   - only tools whose output is aggregate-only are exposed
//     (AGENTS_API_ELIGIBLE_TOOLS), and each result is rebuilt from named
//     numeric fields with small counts withheld and the rest rounded before it
//     leaves the server (minimiseForAgentsApi);
//   - only the question being asked is sent: no earlier turn of the chat, from
//     either side, whatever the client supplies (agentsApiInput);
//   - every turn runs in a fresh session that is deleted as soon as the turn
//     ends, with a sweep (startup, timer and after turns; see
//     assistant.service.ts) for any session a crash or timeout left behind;
//   - every turn that sent anything to OpenAI writes an assistant_audit row,
//     whether or not a session id ever came back;
//   - environment "none", programmatic tool calling and subagents off, no
//     hosted tools, no MCP, no sandbox, no computer use: the harness can only
//     ask OUR server to run a function, which goes through the same
//     executeAssistantTool (role allowlist, caller scoping, audit row) as the
//     stateless backend. The session echoes its resolved tool list when it is
//     created, and the turn stops there if anything else is switched on.
// Read-only like the stateless backend: no tool here or there changes anything.
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { pool } from '../config/db.js';
import { getOpenAIKey } from '../config/secrets.js';
import { createLogger } from '../utils/logger.js';
import {
  ASSISTANT_MODEL,
  assistantSystemPrompt,
  executeAssistantTool,
  toolsFor,
  type AssistantBackend,
  type AssistantContext,
  type AssistantMessage,
  type AssistantRole,
  type AssistantTool,
  type AssistantTurnResult,
  type AuditedToolCall,
} from './assistant.service.js';

const log = createLogger('assistantAgentsApi');

/** Tools whose output carries no per-participant row: the only ones allowed
 *  to reach a store that keeps state until deleted. */
export const AGENTS_API_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set(['study_overview']);

/** Aggregates over fewer participants than this are suppressed on this path. */
export const AGENTS_API_MIN_CELL = 5;

/** Metadata on every session this app creates; the sweep deletes only these. */
export const AGENTS_API_SESSION_APP = 'ai-therapist-admin-assistant';

/** assistant_audit.model value for turns that ran on this backend. */
export const AGENTS_API_AUDIT_MODEL = `agents-api:${ASSISTANT_MODEL}`;

/** Vendor-side spend ceiling per session, in USD cents. Best-effort at OpenAI
 *  ("actual spend can exceed the limit"); a turn that reaches it fails. */
export const AGENTS_API_SESSION_SPEND_LIMIT_CENTS = 25;

/**
 * One deadline for everything that happens before the staff member gets an
 * answer: creating the session, the stream, running tools and posting their
 * results. When it passes the turn fails. Nothing after it is waited for (the
 * audit row is one local insert; usage lookup and session deletion run after
 * the response), so the request ends well inside the 100 s the proxy in front
 * of the app allows, with room to spare under 60 s.
 */
export const AGENTS_API_TURN_TIMEOUT_MS = 40_000;
const MAX_TOOL_CALLS = 12;
/** Timeout for every call other than the turn stream (usage lookups, deletes,
 *  the sweep). The SDK default is ten minutes, with two retries on top; every
 *  call here is made without retries. */
export const AGENTS_API_CONTROL_TIMEOUT_MS = 5_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const ORPHAN_AGE_MS = 5 * 60_000;
const SWEEP_MAX_PAGES = 5;
const USAGE_POLL_ATTEMPTS = 8;
const USAGE_POLL_INTERVAL_MS = 500;
/** A turn that ended without learning its session id looks for the session by
 *  its turn tag straight away and once more after this long (OpenAI says new
 *  sessions "may take time to appear in filtered results"). */
const TURN_TAG_RECHECK_MS = 30_000;

export function agentsApiTools(role: AssistantRole): AssistantTool[] {
  return toolsFor(role).filter((t) => AGENTS_API_ELIGIBLE_TOOLS.has(t.name));
}

/** The assistant's own instructions plus a backend note naming what this
 *  path cannot see. The shared prompt text is unchanged. */
export function agentsApiInstructions(ctx: AssistantContext): string {
  const tools = agentsApiTools(ctx.role);
  return [
    assistantSystemPrompt(ctx, tools),
    'Backend note: this deployment of the assistant only exposes aggregate study figures. Data about individual participants, sessions, crisis events, escalations, work queues or caseloads is not available here; when asked for it, say so and name the admin panel that shows it.',
    'Counts in tool results are rounded to the nearest 5 and any count under 5 is withheld (null): say "about" for a count, say a withheld figure is withheld, and never estimate or back-calculate one.',
    'Each question reaches you on its own: you cannot see earlier questions or answers from this chat. If a question depends on one, ask for it to be restated in full.',
    'You have no shell, files, network or other tools beyond the functions listed above.',
  ].join('\n');
}

/**
 * What is sent as the session input: the question being asked, and nothing
 * else. The chat history the client supplies is NOT sent, in either direction:
 *   - an earlier assistant turn may have come from the stateless backend,
 *     whose tools return per-participant rows (usernames, crisis events), and
 *     this server cannot tell which backend wrote a turn it is handed back;
 *   - an earlier turn of either role is client-supplied text this backend
 *     never produced or checked.
 * Sending the latest staff message only is the one rule that is safe whatever
 * the client sends, so it is enforced here and not left to the UI. The cost
 * is that a follow-up question has to stand on its own; the instructions tell
 * the model so.
 */
export function agentsApiInput(history: AssistantMessage[]): string {
  return history.filter((m) => m.role === 'user').at(-1)?.content ?? '';
}

const FUNNEL_KEYS = ['baselineFinished', 'accountsCreated', 'unlinkedFinished'] as const;
const WEEKLY_KEYS = ['avgMood', 'avgStress', 'avgHelpfulness'] as const;
const INSTRUMENT_AVERAGE_KEYS = ['avgPhq2', 'avgGad2'] as const;
const INSTRUMENT_COUNT_KEYS = ['phq2Positive', 'gad2Positive'] as const;
const INSTRUMENT_ROLES: ReadonlySet<unknown> = new Set(['baseline', 'exit', 'week12']);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Counts are rounded to a multiple of this on this backend. */
export const AGENTS_API_COUNT_ROUNDING = 5;

/**
 * The small-count rule, applied to every count that leaves on this backend:
 *   1. a count under AGENTS_API_MIN_CELL (zero included) is withheld (null);
 *   2. every other count is rounded to the nearest AGENTS_API_COUNT_ROUNDING,
 *      so a withheld count cannot be recovered by subtracting two published
 *      ones (enrolled minus linked, one week's n minus the next);
 *   3. a count of members with a property (screen positives) is also withheld
 *      when the members WITHOUT it number under AGENTS_API_MIN_CELL, because
 *      "5 of 5 positive" or "29 of 30 positive" says as much about each
 *      person as a small count does.
 */
function publishedCount(v: unknown): number | null {
  const n = numberOrNull(v);
  if (n === null || n < AGENTS_API_MIN_CELL) return null;
  return Math.round(n / AGENTS_API_COUNT_ROUNDING) * AGENTS_API_COUNT_ROUNDING;
}

const COUNT_RULE = `Counts are rounded to the nearest ${AGENTS_API_COUNT_ROUNDING}. A count under ${AGENTS_API_MIN_CELL}, and a count that would reveal a group under ${AGENTS_API_MIN_CELL}, is withheld (null).`;

/** One aggregate cell, rebuilt from named numeric fields only. `averages`
 *  pass through for a cell of AGENTS_API_MIN_CELL participants or more;
 *  `counts` (members of the cell with a property) follow the small-count
 *  rule. A smaller cell keeps its label and loses its n and every figure. A
 *  cell without a numeric n is dropped. */
function cell(
  raw: Record<string, unknown>,
  label: Record<string, unknown>,
  averages: readonly string[],
  counts: readonly string[] = [],
): Record<string, unknown> | null {
  const n = numberOrNull(raw.n);
  if (n === null) return null;
  const small = n < AGENTS_API_MIN_CELL;
  const out: Record<string, unknown> = { ...label, n: publishedCount(n) };
  for (const f of averages) out[f] = small ? null : numberOrNull(raw[f]);
  for (const f of counts) {
    const c = numberOrNull(raw[f]);
    out[f] = small || c === null || n - c < AGENTS_API_MIN_CELL ? null : publishedCount(c);
  }
  if (small) out.suppressed = `fewer than ${AGENTS_API_MIN_CELL} participants`;
  return out;
}

/**
 * What a tool result may carry into the Agents API session store. An
 * allow-list, not a filter: the result is REBUILT from named numeric fields,
 * so a field later added to study_overview (or a string that found its way
 * into one) cannot ride along. Every count follows the small-count rule on
 * publishedCount above, and an average over fewer than AGENTS_API_MIN_CELL
 * participants (one or two people's own scores) is nulled. A tool outside
 * AGENTS_API_ELIGIBLE_TOOLS can only ever return a refusal.
 *
 * Residual, stated rather than hidden: `n` counts the participants with a
 * response in the cell, and an average skips unanswered items, so a figure in
 * a cell of five or more can still rest on fewer than five answers.
 */
export function minimiseForAgentsApi(name: string, output: unknown): unknown {
  const o = asRecord(output);
  if (typeof o.error === 'string') return { error: o.error };
  if (name !== 'study_overview' || !AGENTS_API_ELIGIBLE_TOOLS.has(name)) {
    return { error: `Tool ${name} is not available on this assistant backend.` };
  }
  const funnelIn = asRecord(o.funnel);
  const funnel: Record<string, number | null> = {};
  for (const k of FUNNEL_KEYS) funnel[k] = publishedCount(funnelIn[k]);
  const cells = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.map(asRecord) : []);
  return {
    countRule: COUNT_RULE,
    funnel,
    participantCount: publishedCount(o.participantCount),
    weeklyAggregates: cells(o.weeklyAggregates)
      .map((c) => cell(c, { week: numberOrNull(c.week) }, WEEKLY_KEYS))
      .filter((c) => c !== null),
    instrumentAggregates: cells(o.instrumentAggregates)
      .map((c) =>
        INSTRUMENT_ROLES.has(c.role) ? cell(c, { role: c.role }, INSTRUMENT_AVERAGE_KEYS, INSTRUMENT_COUNT_KEYS) : null,
      )
      .filter((c) => c !== null),
  };
}

function parseArgs(raw: unknown, name: string): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    log.warn(`unparseable arguments for ${name}; running with {}`);
  }
  return {};
}

// Minimal structural view of the SDK surface this module uses (test seam).
interface TokenCounts {
  input_tokens?: number;
  output_tokens?: number;
}
interface AgentsEvent {
  type: string;
  session_id?: string;
  /** Root-agent usage, also carried at the top level of turn.completed. */
  usage?: TokenCounts | null;
  session?: {
    id?: string;
    required_actions?: Array<Record<string, unknown>>;
    agent?: { tools?: Array<Record<string, unknown>> | null } | null;
    /** "The error that caused the session to fail, if any": a plain string. */
    error?: string | null;
  };
  turn?: {
    session_id?: string;
    subagent_id?: string | null;
    usage?: TokenCounts | null;
    error?: { code?: string; message?: string } | null;
  };
  text?: string;
  error?: { message?: string; code?: string | null };
}
interface AgentsStream extends AsyncIterable<AgentsEvent> {
  controller?: AbortController;
}
interface AgentsSessionSummary {
  id: string;
  created_at: number;
  metadata?: Record<string, string> | null;
}
interface CallOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}
export interface AgentsClient {
  beta: {
    agents: {
      sessions: {
        create: (body: Record<string, unknown>, options?: CallOptions) => Promise<AgentsStream>;
        retrieve: (sessionId: string, options?: CallOptions) => Promise<{ usage?: TokenCounts | null }>;
        delete: (sessionId: string, options?: CallOptions) => Promise<unknown>;
        // The SDK's page object carries `data` and `has_more` only (no last_id).
        list: (
          query?: Record<string, unknown>,
          options?: CallOptions,
        ) => Promise<{ data: AgentsSessionSummary[]; has_more?: boolean }>;
        events: {
          create: (
            sessionId: string,
            body: { events: Array<Record<string, unknown>> },
            options?: CallOptions,
          ) => Promise<unknown>;
        };
      };
    };
  };
}

/** No retries anywhere: a retried create could leave a second session behind
 *  that this turn never hears about, and a retried call multiplies its
 *  timeout. A call that fails is left to the sweep or to the staff member
 *  asking again. */
const CONTROL: CallOptions = { timeout: AGENTS_API_CONTROL_TIMEOUT_MS, maxRetries: 0 };

let cachedClient: AgentsClient | null = null;
async function getClient(): Promise<AgentsClient> {
  if (!cachedClient) cachedClient = new OpenAI({ apiKey: await getOpenAIKey() }) as unknown as AgentsClient;
  return cachedClient;
}

/** Test seam. */
export function setAgentsClientForTest(client: AgentsClient | null): void {
  cachedClient = client;
  lastSweepAt = 0;
}

function sessionIdOf(ev: AgentsEvent): string | null {
  return ev.session?.id ?? ev.session_id ?? ev.turn?.session_id ?? null;
}

async function deleteSession(client: AgentsClient, sessionId: string): Promise<void> {
  try {
    await client.beta.agents.sessions.delete(sessionId, CONTROL);
  } catch (err) {
    // An in-progress turn may refuse deletion; cancel it and try once more.
    try {
      await client.beta.agents.sessions.events.create(
        sessionId,
        { events: [{ type: 'agent.session.input.cancel' }] },
        CONTROL,
      );
      await client.beta.agents.sessions.delete(sessionId, CONTROL);
    } catch (err2) {
      log.error({ err, err2, sessionId }, 'agents api session delete failed; the sweep will retry');
    }
  }
}

/**
 * Usage is "best-effort": observed live (2026-11-18 and again 2026-11-26) as
 * null on turn.completed and populated on the session about two seconds
 * later. Poll briefly before the session is deleted (deletion takes the
 * figure with it), so the audit row and cost tracking carry real numbers.
 * Runs after the answer has gone back to the staff member, never before.
 * Returns null if it never appears within the budget.
 */
async function awaitUsage(
  client: AgentsClient,
  sessionId: string,
): Promise<{ input_tokens: number; output_tokens: number } | null> {
  for (let i = 0; i < USAGE_POLL_ATTEMPTS; i++) {
    try {
      const u = (await client.beta.agents.sessions.retrieve(sessionId, CONTROL)).usage;
      if (u && typeof u.input_tokens === 'number') {
        return { input_tokens: u.input_tokens, output_tokens: u.output_tokens ?? 0 };
      }
    } catch (err) {
      log.warn({ err, sessionId }, 'agents api usage lookup failed');
      return null;
    }
    await new Promise((r) => setTimeout(r, USAGE_POLL_INTERVAL_MS));
  }
  return null;
}

let lastSweepAt = 0;

/**
 * Delete any session this app created more than ORPHAN_AGE_MS ago (a crash or
 * timeout between create and the delete that follows a turn). The list is
 * filtered at OpenAI on our metadata tag and every row is checked again here,
 * so a session that is not ours is never deleted. Bounded to SWEEP_MAX_PAGES
 * pages a run. Returns the number deleted.
 *
 * Runs at startup and on a timer while the flag is on, and for a while after
 * it is switched off (startAgentsApiSweeper in assistant.service.ts), as well
 * as after turns. The one case left to a person: the process crashes mid-turn
 * AND the flag is off by the time it restarts. Then call this once by hand.
 */
export async function sweepOrphanedAgentSessions(now: number = Date.now()): Promise<number> {
  const client = await getClient();
  let deleted = 0;
  let after: string | undefined;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const res = await client.beta.agents.sessions.list(
      { limit: 100, order: 'desc', metadata: { app: AGENTS_API_SESSION_APP }, ...(after ? { after } : {}) },
      CONTROL,
    );
    for (const s of res.data) {
      if (s.metadata?.app !== AGENTS_API_SESSION_APP) continue;
      if (now - s.created_at * 1000 < ORPHAN_AGE_MS) continue;
      await deleteSession(client, s.id);
      deleted++;
    }
    const last = res.data.at(-1)?.id;
    if (!res.has_more || !last) break;
    after = last;
  }
  return deleted;
}

function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  sweepOrphanedAgentSessions(now).catch((err: unknown) => log.error({ err }, 'agents api session sweep failed'));
}

/**
 * Delete the session(s) of one turn, found by the turn tag in their metadata.
 * For a turn that never learned its session id (a timeout or a dropped
 * connection before the first stream event): the request had been sent, so a
 * session holding the question may exist. Both tags are checked again on
 * every row before anything is deleted. No age guard is needed: the turn that
 * owned the tag is over. Returns the number deleted.
 */
async function deleteSessionsOfTurn(client: AgentsClient, turnTag: string): Promise<number> {
  try {
    const res = await client.beta.agents.sessions.list(
      { limit: 20, metadata: { app: AGENTS_API_SESSION_APP, turn: turnTag } },
      CONTROL,
    );
    let deleted = 0;
    for (const s of res.data) {
      if (s.metadata?.app !== AGENTS_API_SESSION_APP || s.metadata?.turn !== turnTag) continue;
      await deleteSession(client, s.id);
      deleted++;
    }
    if (deleted > 0) log.warn({ turnTag, deleted }, 'agents api: deleted a session its turn never saw');
    return deleted;
  } catch (err) {
    log.error({ err, turnTag }, 'agents api turn-tag lookup failed; the sweep will retry');
    return 0;
  }
}

// Work that follows a turn (usage lookup, session deletion) runs here, after
// the answer has been returned. Tracked so tests can wait for it.
const background = new Set<Promise<void>>();
function inBackground(work: Promise<unknown>): void {
  const tracked: Promise<void> = work
    .then(
      () => undefined,
      (err: unknown) => log.error({ err }, 'agents api after-turn work failed'),
    )
    .finally(() => background.delete(tracked));
  background.add(tracked);
}

/** Test seam: resolves once every after-turn task started so far is done. */
export async function agentsApiAfterTurnWork(): Promise<void> {
  while (background.size > 0) await Promise.all([...background]);
}

/**
 * The turn's assistant_audit row. Same columns as insertAudit in
 * assistant.service.ts (left untouched so the stateless path is unchanged),
 * but it returns the row id, because on this backend the token counts arrive
 * after the answer and are added to the row then. Never throws.
 */
async function insertAgentsAudit(
  ctx: AssistantContext,
  question: string,
  tools: AuditedToolCall[],
  usage: { input_tokens: number; output_tokens: number },
): Promise<number | null> {
  try {
    const result = await pool.query<{ audit_id: string | number }>(
      `INSERT INTO assistant_audit (user_id, role, question, tools, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING audit_id`,
      [
        ctx.userId,
        ctx.role,
        question.slice(0, 4000),
        JSON.stringify(tools),
        AGENTS_API_AUDIT_MODEL,
        usage.input_tokens,
        usage.output_tokens,
      ],
    );
    const id = Number(result.rows?.[0]?.audit_id);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    log.error({ err }, 'assistant audit insert failed');
    return null;
  }
}

async function recordLateUsage(auditId: number, usage: { input_tokens: number; output_tokens: number }): Promise<void> {
  try {
    await pool.query('UPDATE assistant_audit SET input_tokens = $1, output_tokens = $2 WHERE audit_id = $3', [
      usage.input_tokens,
      usage.output_tokens,
      auditId,
    ]);
  } catch (err) {
    log.error({ err, auditId }, 'assistant audit usage update failed');
  }
}

/** Everything owed to OpenAI and to the audit row once a turn is over. Runs
 *  after the response; nothing here can delay or fail the answer. */
async function settleTurn(
  client: AgentsClient,
  turn: { sessionId: string | null; turnTag: string; auditId: number | null; wantUsage: boolean },
): Promise<void> {
  if (turn.sessionId) {
    if (turn.wantUsage && turn.auditId !== null) {
      const late = await awaitUsage(client, turn.sessionId);
      if (late) await recordLateUsage(turn.auditId, late);
    }
    await deleteSession(client, turn.sessionId);
    return;
  }
  // No session id came back, but the request was sent: look for the session
  // by its turn tag now and once more shortly, and leave the rest to the sweep.
  await deleteSessionsOfTurn(client, turn.turnTag);
  const recheck = setTimeout(() => inBackground(deleteSessionsOfTurn(client, turn.turnTag)), TURN_TAG_RECHECK_MS);
  recheck.unref?.();
}

/** Tools the created session reports as switched on that we did not ask for. */
function unexpectedTools(tools: Array<Record<string, unknown>>, allowed: ReadonlySet<string>): string[] {
  return tools
    .filter((t) => t.enabled !== false && !(t.type === 'function' && allowed.has(String(t.name))))
    .map((t) => (t.type === 'function' ? `function:${String(t.name)}` : String(t.type)));
}

/** The code a turn fails with when the session reaches its spend_control
 *  limit (SessionTurnError.code in the SDK; "A turn stopped by the budget
 *  fails with session_budget_exceeded" in the session-budget guide). */
export const AGENTS_API_SPEND_CEILING_CODE = 'session_budget_exceeded';

/** A turn that did not produce an answer; `code` says why. */
export class AgentsApiTurnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentsApiTurnError';
  }
}

/**
 * The failure a stream event reports, or null for any other event.
 *
 * The spend ceiling, checked against openai 7.57.0 and the docs on
 * 2026-11-26: the SDK's event union has no budget event; the ceiling arrives
 * as agent.session.turn.failed with turn.error.code session_budget_exceeded
 * (and the stream `error` event carries the same code field). The guide also
 * names an `agent.session.budget_reached` event and session status that the
 * SDK does not type; it is treated as the ceiling too, in case it is sent.
 */
function failureOf(ev: AgentsEvent): AgentsApiTurnError | null {
  let code: string;
  let detail: string;
  switch (ev.type) {
    case 'agent.session.turn.failed':
    case 'agent.session.turn.cancelled':
      if (ev.turn?.subagent_id) return null;
      code = ev.turn?.error?.code ?? ev.type;
      detail = ev.turn?.error?.message ?? '';
      break;
    case 'agent.session.failed':
      detail = ev.session?.error ?? '';
      code = detail.includes(AGENTS_API_SPEND_CEILING_CODE) ? AGENTS_API_SPEND_CEILING_CODE : ev.type;
      break;
    case 'agent.session.budget_reached':
      code = AGENTS_API_SPEND_CEILING_CODE;
      detail = '';
      break;
    case 'error':
      code = ev.error?.code ?? ev.type;
      detail = ev.error?.message ?? '';
      break;
    default:
      return null;
  }
  if (code === AGENTS_API_SPEND_CEILING_CODE) {
    return new AgentsApiTurnError(
      code,
      `agents api turn stopped at the session spend ceiling of ${AGENTS_API_SESSION_SPEND_LIMIT_CENTS} cents (${code})`,
    );
  }
  return new AgentsApiTurnError(code, `agents api turn ended with ${ev.type} (${code}): ${detail}`);
}

async function runAgentsApiTurn(ctx: AssistantContext, history: AssistantMessage[]): Promise<AssistantTurnResult> {
  const client = await getClient();
  const available = agentsApiTools(ctx.role);
  const allowedNames = new Set(available.map((t) => t.name));
  const question = agentsApiInput(history);
  const turnTag = randomUUID();
  const auditTools: AuditedToolCall[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  // One deadline for the whole turn. Every await below races it, so the turn
  // ends on time even if a call ignores the abort signal.
  const abort = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    abort.signal.addEventListener(
      'abort',
      () =>
        reject(
          new AgentsApiTurnError('timeout', `agents api turn timed out after ${AGENTS_API_TURN_TIMEOUT_MS / 1000} s`),
        ),
      { once: true },
    );
  });
  deadline.catch(() => undefined);
  const inTime = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  const timer = setTimeout(() => abort.abort(), AGENTS_API_TURN_TIMEOUT_MS);

  let sessionId: string | null = null;
  let stream: AgentsStream | null = null;
  let answer = '';
  let completed = false;

  // From here on the question is on its way to OpenAI, so whatever happens
  // next (an answer, a failure, a timeout, a dropped connection before the
  // first event) the `finally` below writes the audit row and starts cleanup.
  try {
    const creating = client.beta.agents.sessions.create(
      {
        agent: {
          model: ASSISTANT_MODEL,
          instructions: agentsApiInstructions(ctx),
          tools: [
            { type: 'programmatic_tool_calling', enabled: false },
            ...available.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          ],
          multi_agent: { enabled: false },
        },
        environment: { type: 'none' },
        review: 'none',
        spend_control: { limit: AGENTS_API_SESSION_SPEND_LIMIT_CENTS },
        metadata: { app: AGENTS_API_SESSION_APP, turn: turnTag },
        input: question,
        stream: true,
      },
      { signal: abort.signal, maxRetries: 0 },
    );
    // If the deadline wins, close a stream that still arrives afterwards.
    creating.then(
      (late) => {
        if (abort.signal.aborted) late.controller?.abort();
      },
      () => undefined,
    );
    stream = await inTime(creating);

    const events = stream[Symbol.asyncIterator]();
    const handled = new Set<string>();
    while (!completed) {
      const step = await inTime(events.next());
      if (step.done) break;
      const ev = step.value;
      sessionId ??= sessionIdOf(ev);
      const failure = failureOf(ev);
      if (failure) throw failure;
      if (ev.type === 'agent.session.created') {
        // Fail closed if a vendor default ever switches a hosted tool on: the
        // model has not run yet, and the session is deleted on the way out.
        const extra = unexpectedTools(ev.session?.agent?.tools ?? [], allowedNames);
        if (extra.length > 0) throw new Error(`agents api session has unexpected tools: ${extra.join(', ')}`);
      } else if (ev.type === 'agent.session.requires_action') {
        const results: Array<Record<string, unknown>> = [];
        for (const action of ev.session?.required_actions ?? []) {
          if (action.type !== 'function_call') {
            // Nothing else is configured, so any other request is unexpected:
            // fail closed rather than approve something unseen.
            throw new Error(`unexpected required action ${String(action.type)}`);
          }
          const callId = String(action.call_id);
          if (handled.has(callId)) continue;
          handled.add(callId);
          const name = String(action.name);
          const base = { type: 'agent.session.input.tool_result', turn_id: action.turn_id, call_id: callId };
          if (handled.size > MAX_TOOL_CALLS) {
            results.push({ ...base, success: false, error: 'Tool budget for this question is exhausted; answer now.' });
            continue;
          }
          const args = parseArgs(action.arguments, name);
          const { output, audit } = await inTime(executeAssistantTool(ctx, available, name, args));
          auditTools.push(audit);
          results.push({ ...base, success: true, output: JSON.stringify(minimiseForAgentsApi(name, output)) });
        }
        if (results.length > 0) {
          if (!sessionId) throw new Error('agents api asked for a tool before naming its session');
          await inTime(
            client.beta.agents.sessions.events.create(
              sessionId,
              { events: results },
              { ...CONTROL, signal: abort.signal },
            ),
          );
        }
      } else if (ev.type === 'agent.session.turn.output_text.done') {
        answer = ev.text ?? answer;
      } else if (ev.type === 'agent.session.turn.completed' && !ev.turn?.subagent_id) {
        const u = ev.turn?.usage ?? ev.usage;
        usage.input_tokens = u?.input_tokens ?? 0;
        usage.output_tokens = u?.output_tokens ?? 0;
        completed = true;
      }
    }
    if (!completed) throw new Error('agents api stream closed before the turn completed');
  } finally {
    clearTimeout(timer);
    stream?.controller?.abort();
    // Access logging is never weaker than the stateless path, and on this
    // backend the question is stored at OpenAI from the moment it is sent:
    // the row is written on every path, before the answer or the error
    // leaves this function. Token counts that arrive late are added after.
    const auditId = await insertAgentsAudit(ctx, question, auditTools, usage);
    inBackground(settleTurn(client, { sessionId, turnTag, auditId, wantUsage: completed && usage.input_tokens === 0 }));
    maybeSweep();
  }

  return {
    answer: answer || 'I could not produce an answer for that. Try rephrasing, or use the relevant admin panel.',
    toolCalls: auditTools.map((t) => ({ name: t.name, rowCount: t.row_count })),
  };
}

export const agentsApiBackend: AssistantBackend = { id: 'agents_api', runTurn: runAgentsApiTurn };
