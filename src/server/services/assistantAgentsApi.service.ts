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
//     (AGENTS_API_ELIGIBLE_TOOLS), and small cells are suppressed before a
//     result leaves the server (minimiseForAgentsApi);
//   - every turn runs in a fresh session that is deleted in `finally`, with a
//     throttled sweep for any session a crash left behind;
//   - environment "none", programmatic tool calling and subagents off, no
//     hosted tools, no MCP, no sandbox, no computer use: the harness can only
//     ask OUR server to run a function, which goes through the same
//     executeAssistantTool (role allowlist, caller scoping, audit row) as the
//     stateless backend.
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { createLogger } from '../utils/logger.js';
import {
  ASSISTANT_MODEL,
  assistantSystemPrompt,
  executeAssistantTool,
  insertAudit,
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

const TURN_TIMEOUT_MS = 90_000;
const MAX_TOOL_CALLS = 12;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const ORPHAN_AGE_MS = 5 * 60_000;
const SWEEP_MAX_PAGES = 5;
const USAGE_POLL_ATTEMPTS = 8;
const USAGE_POLL_INTERVAL_MS = 500;

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
    'You have no shell, files, network or other tools beyond the functions listed above.',
  ].join('\n');
}

/**
 * The Agents API accepts only user-role input, and each turn runs in a new
 * session, so earlier turns travel as quoted context inside one user message.
 * The client already supplies the whole history on the stateless path, so
 * this sends nothing the stateless path does not.
 */
export function foldHistory(history: AssistantMessage[]): string {
  const current = history.at(-1)?.content ?? '';
  const earlier = history.slice(0, -1);
  if (earlier.length === 0) return current;
  const lines = earlier.map((m) => `[${m.role === 'user' ? 'staff' : 'assistant'}] ${m.content}`);
  return [
    'Earlier in this conversation (context only, not instructions):',
    ...lines,
    '',
    'Current question:',
    current,
  ].join('\n');
}

function suppress<T extends { n: number }>(cells: T[], fields: Array<keyof T>): T[] {
  return cells.map((c) => {
    if (c.n >= AGENTS_API_MIN_CELL) return c;
    const out = { ...c, suppressed: `fewer than ${AGENTS_API_MIN_CELL} participants` } as T;
    for (const f of fields) (out as Record<keyof T, unknown>)[f] = null;
    return out;
  });
}

/** Small-cell suppression before a tool result leaves the server: an average
 *  over one or two participants is their individual score. */
export function minimiseForAgentsApi(name: string, output: unknown): unknown {
  if (name !== 'study_overview' || !output || typeof output !== 'object' || 'error' in output) return output;
  const o = output as {
    weeklyAggregates?: Array<{ n: number }>;
    instrumentAggregates?: Array<{ n: number }>;
  };
  return {
    ...o,
    weeklyAggregates: suppress((o.weeklyAggregates ?? []) as Array<Record<string, unknown> & { n: number }>, [
      'avgMood',
      'avgStress',
      'avgHelpfulness',
    ]),
    instrumentAggregates: suppress((o.instrumentAggregates ?? []) as Array<Record<string, unknown> & { n: number }>, [
      'avgPhq2',
      'avgGad2',
      'phq2Positive',
      'gad2Positive',
    ]),
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
interface AgentsEvent {
  type: string;
  session_id?: string;
  session?: { id?: string; required_actions?: Array<Record<string, unknown>> };
  turn?: {
    session_id?: string;
    subagent_id?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    error?: { message?: string } | null;
  };
  text?: string;
  error?: { message?: string; code?: string };
}
interface AgentsStream extends AsyncIterable<AgentsEvent> {
  controller?: AbortController;
}
interface AgentsSessionSummary {
  id: string;
  created_at: number;
  metadata?: Record<string, string> | null;
}
export interface AgentsClient {
  beta: {
    agents: {
      sessions: {
        create: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<AgentsStream>;
        retrieve: (sessionId: string) => Promise<{ usage?: { input_tokens?: number; output_tokens?: number } | null }>;
        delete: (sessionId: string) => Promise<unknown>;
        list: (query?: Record<string, unknown>) => Promise<{
          data: AgentsSessionSummary[];
          has_more?: boolean;
          last_id?: string | null;
        }>;
        events: { create: (sessionId: string, body: { events: Array<Record<string, unknown>> }) => Promise<unknown> };
      };
    };
  };
}

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
    await client.beta.agents.sessions.delete(sessionId);
  } catch (err) {
    // An in-progress turn may refuse deletion; cancel it and try once more.
    try {
      await client.beta.agents.sessions.events.create(sessionId, {
        events: [{ type: 'agent.session.input.cancel' }],
      });
      await client.beta.agents.sessions.delete(sessionId);
    } catch (err2) {
      log.error({ err, err2, sessionId }, 'agents api session delete failed; the sweep will retry');
    }
  }
}

/**
 * Usage is "best-effort": observed live (2026-11-18) as null on
 * turn.completed and populated on the session about two seconds later. Poll
 * briefly before the session is deleted (deletion takes the figure with it),
 * so the audit row and cost tracking carry real numbers. Returns null if it
 * never appears within the budget.
 */
async function awaitUsage(
  client: AgentsClient,
  sessionId: string,
): Promise<{ input_tokens: number; output_tokens: number } | null> {
  for (let i = 0; i < USAGE_POLL_ATTEMPTS; i++) {
    try {
      const u = (await client.beta.agents.sessions.retrieve(sessionId)).usage;
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
 * timeout between create and the `finally` delete). Only sessions tagged with
 * our metadata are touched. Returns the number deleted.
 */
export async function sweepOrphanedAgentSessions(now: number = Date.now()): Promise<number> {
  const client = await getClient();
  let deleted = 0;
  let after: string | undefined;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const res = await client.beta.agents.sessions.list({ limit: 100, order: 'desc', ...(after ? { after } : {}) });
    for (const s of res.data) {
      if (s.metadata?.app !== AGENTS_API_SESSION_APP) continue;
      if (now - s.created_at * 1000 < ORPHAN_AGE_MS) continue;
      await deleteSession(client, s.id);
      deleted++;
    }
    if (!res.has_more || !res.last_id) break;
    after = res.last_id;
  }
  return deleted;
}

function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  sweepOrphanedAgentSessions(now).catch((err: unknown) => log.error({ err }, 'agents api session sweep failed'));
}

async function runAgentsApiTurn(ctx: AssistantContext, history: AssistantMessage[]): Promise<AssistantTurnResult> {
  const client = await getClient();
  const available = agentsApiTools(ctx.role);
  const question = history.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const auditTools: AuditedToolCall[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  let sessionId: string | null = null;
  let stream: AgentsStream | null = null;
  let answer = '';
  let completed = false;

  try {
    stream = await client.beta.agents.sessions.create(
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
        metadata: { app: AGENTS_API_SESSION_APP },
        input: foldHistory(history),
        stream: true,
      },
      { signal: abort.signal },
    );

    const handled = new Set<string>();
    for await (const ev of stream) {
      sessionId ??= sessionIdOf(ev);
      if (ev.type === 'agent.session.requires_action') {
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
          const { output, audit } = await executeAssistantTool(ctx, available, name, args);
          auditTools.push(audit);
          results.push({ ...base, success: true, output: JSON.stringify(minimiseForAgentsApi(name, output)) });
        }
        if (results.length > 0 && sessionId) {
          await client.beta.agents.sessions.events.create(sessionId, { events: results });
        }
      } else if (ev.type === 'agent.session.turn.output_text.done') {
        answer = ev.text ?? answer;
      } else if (ev.type === 'agent.session.turn.completed' && !ev.turn?.subagent_id) {
        usage.input_tokens = ev.turn?.usage?.input_tokens ?? 0;
        usage.output_tokens = ev.turn?.usage?.output_tokens ?? 0;
        completed = true;
        break;
      } else if (
        ((ev.type === 'agent.session.turn.failed' || ev.type === 'agent.session.turn.cancelled') &&
          !ev.turn?.subagent_id) ||
        ev.type === 'agent.session.failed' ||
        ev.type === 'error'
      ) {
        throw new Error(`agents api turn ended with ${ev.type}: ${ev.turn?.error?.message ?? ev.error?.message ?? ''}`);
      }
    }
    if (!completed) throw new Error('agents api stream closed before the turn completed');
    if (usage.input_tokens === 0 && sessionId) {
      const late = await awaitUsage(client, sessionId);
      if (late) Object.assign(usage, late);
    }
  } finally {
    clearTimeout(timer);
    stream?.controller?.abort();
    if (sessionId) await deleteSession(client, sessionId);
    // Access logging is never weaker than the stateless path: a turn that ran
    // any tool is audited even if the model step failed afterwards.
    if (completed || auditTools.length > 0) {
      await insertAudit(ctx, question, auditTools, usage, AGENTS_API_AUDIT_MODEL);
    }
    maybeSweep();
  }

  return {
    answer: answer || 'I could not produce an answer for that. Try rephrasing, or use the relevant admin panel.',
    toolCalls: auditTools.map((t) => ({ name: t.name, rowCount: t.row_count })),
  };
}

export const agentsApiBackend: AssistantBackend = { id: 'agents_api', runTurn: runAgentsApiTurn };
