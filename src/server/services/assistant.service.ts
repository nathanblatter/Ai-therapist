// Admin assistant (docs/admin-assistant-spec.md, ai-therapist-161): a
// read-only tool-calling agent over EXISTING role-scoped query modules.
// Structural safety properties, enforced here rather than in the prompt:
//   - every tool wraps an existing db/*.queries function and receives the
//     CALLER's userId/role/orgId injected server-side — the model never
//     chooses the identity it queries as;
//   - per-tool role allowlists mirror the admin portal's requireRole gates;
//   - tool outputs are whitelist-projected to aggregates/metadata/scores —
//     no verbatim participant text ever enters model context in v1;
//   - no writes: there is no tool that mutates anything.
// Every turn appends an assistant_audit row (who asked what, which tools ran,
// row counts — never payloads).
import OpenAI from 'openai';
import { getOpenAIKey } from '../config/secrets.js';
import { pool } from '../config/db.js';
import {
  listSessions,
  getAllCrisisData,
  listCaseworkerRoster,
  getAllUsers,
  listEscalations,
  listWorkItemsForMember,
  listWorkItemsForOrg,
  isAssigned,
} from '../db/index.js';
import { getSurveyDataOverview } from './surveyData.service.js';
import { isCareTeamRole } from '../../shared/roles.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('assistant');

export const ASSISTANT_MODEL = 'gpt-5.2';
const MAX_TOOL_ROUNDS = 6;
const MAX_ROWS = 50;

export type AssistantRole = 'therapist' | 'researcher' | 'caseworker';

export interface AssistantContext {
  userId: number;
  role: AssistantRole;
  username: string | null;
  orgId: number | null;
}

export interface AssistantTurnResult {
  answer: string;
  toolCalls: Array<{ name: string; rowCount: number }>;
}

/** Keep only whitelisted keys — the single choke point that guarantees no
 *  free-text column ever rides along into model context. */
function project<T extends Record<string, unknown>>(rows: T[], keys: string[]): Array<Record<string, unknown>> {
  return rows.slice(0, MAX_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in row) out[k] = row[k];
    return out;
  });
}

function rowCountOf(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') {
    const rows = (result as Record<string, unknown>).rows;
    if (Array.isArray(rows)) return rows.length;
    return 1;
  }
  return 0;
}

interface AssistantTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  roles: AssistantRole[];
  run: (ctx: AssistantContext, args: Record<string, unknown>) => Promise<unknown>;
}

const EMPTY_SESSION_FILTERS = {
  search: null, startDate: null, endDate: null, minMessages: null, maxMessages: null,
  voices: null, languages: null, durations: null, sessionTypes: null, statuses: null,
  endedBy: null, crisisSeverity: null,
};

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const TOOLS: AssistantTool[] = [
  {
    name: 'study_overview',
    description:
      'Study-wide survey metrics: enrollment funnel, weekly mood/stress/helpfulness averages, PHQ-2/GAD-2/alliance instrument aggregates, participant count.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    roles: ['researcher'],
    run: async () => {
      const o = await getSurveyDataOverview();
      return {
        funnel: o.funnel,
        participantCount: o.participants.length,
        weeklyAggregates: o.weeklyAggregates,
        instrumentAggregates: o.instrumentAggregates,
      };
    },
  },
  {
    name: 'survey_completion',
    description:
      'Per-participant survey completion: study week, which weekly check-ins are done, baseline/exit/week-12 status. Therapists see their caseload only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    roles: ['researcher', 'therapist'],
    run: async (ctx) => {
      const o = await getSurveyDataOverview();
      let participants = o.participants;
      if (ctx.role === 'therapist') {
        const roster = await listCaseworkerRoster(ctx.userId);
        const ids = new Set(roster.map((r) => Number(r.client_id)));
        participants = participants.filter((p) => ids.has(p.userId));
      }
      return participants.slice(0, MAX_ROWS).map((p) => ({
        userId: p.userId,
        username: p.username,
        studyWeek: p.studyWeek,
        weeklyCompleted: Object.keys(p.weekly).map(Number).sort((a, b) => a - b),
        baselineDone: p.baseline !== null,
        exitDone: p.exit !== null,
        week12Done: p.week12 !== null,
      }));
    },
  },
  {
    name: 'session_stats',
    description:
      'Recent AI-session metadata: session id, username, status, type, start time, message count, crisis flag. Care-team callers see their caseload only. Optional filters: days_back (default 30), crisis_flagged, user_id.',
    parameters: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Only sessions started in the last N days (default 30)' },
        crisis_flagged: { type: 'boolean', description: 'Only crisis-flagged sessions' },
        user_id: { type: 'number', description: 'Only one participant’s sessions' },
      },
      additionalProperties: false,
    },
    roles: ['researcher', 'therapist', 'caseworker'],
    run: async (ctx, args) => {
      const days = typeof args.days_back === 'number' && args.days_back > 0 ? Math.min(args.days_back, 365) : 30;
      const scope = isCareTeamRole(ctx.role) ? ctx.userId : null;
      const rows = await listSessions(
        {
          ...EMPTY_SESSION_FILTERS,
          startDate: daysAgoIso(days),
          crisisFlagged: typeof args.crisis_flagged === 'boolean' ? args.crisis_flagged : null,
          userId: typeof args.user_id === 'number' ? args.user_id : null,
          limit: MAX_ROWS,
          offset: 0,
        },
        scope,
        ctx.orgId
      );
      return project(rows as Array<Record<string, unknown>>, [
        'session_id', 'username', 'user_id', 'status', 'session_type', 'start_time',
        'end_time', 'message_count', 'crisis_flagged', 'crisis_severity', 'duration_minutes',
      ]);
    },
  },
  {
    name: 'crisis_events',
    description:
      'Crisis events (severity, scores, timestamps, resolution status — no content). Care-team callers see their caseload only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    roles: ['researcher', 'therapist', 'caseworker'],
    run: async (ctx) => {
      const scope = isCareTeamRole(ctx.role) ? ctx.userId : null;
      const data = await getAllCrisisData(scope, ctx.orgId);
      return project((data.crisisEvents ?? []) as Array<Record<string, unknown>>, [
        'event_id', 'session_id', 'client_user_id', 'username', 'severity', 'risk_score',
        'status', 'origin', 'created_at', 'resolved_at',
      ]);
    },
  },
  {
    name: 'escalations',
    description:
      'Care-team escalations (urgency, status, assignee, timestamps — no reason text). Scoped exactly like the Escalations panel.',
    parameters: {
      type: 'object',
      properties: { open_only: { type: 'boolean', description: 'Only open/acknowledged escalations (default true)' } },
      additionalProperties: false,
    },
    roles: ['researcher', 'therapist', 'caseworker'],
    run: async (ctx, args) => {
      const openOnly = typeof args.open_only === 'boolean' ? args.open_only : true;
      const rows = await listEscalations(
        ctx.role === 'researcher'
          ? { orgId: ctx.orgId, openOnly }
          : { memberId: ctx.userId, memberRole: ctx.role, openOnly }
      );
      return project(rows as unknown as Array<Record<string, unknown>>, [
        'escalation_id', 'client_id', 'raised_by', 'raised_by_role', 'assigned_to',
        'urgency', 'status', 'created_at', 'acknowledged_at', 'resolved_at',
      ]);
    },
  },
  {
    name: 'work_queue',
    description:
      'Work-queue items (type, severity, status, timestamps). Care-team callers see their own queue; researchers see the org queue.',
    parameters: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array', items: { type: 'string', enum: ['open', 'acked', 'resolved', 'expired'] },
          description: 'Statuses to include (default open + acked)',
        },
      },
      additionalProperties: false,
    },
    roles: ['researcher', 'therapist', 'caseworker'],
    run: async (ctx, args) => {
      const statuses = Array.isArray(args.statuses) && args.statuses.length > 0
        ? (args.statuses as Array<'open' | 'acked' | 'resolved' | 'expired'>)
        : undefined;
      const rows = isCareTeamRole(ctx.role)
        ? await listWorkItemsForMember(ctx.userId, { statuses, limit: MAX_ROWS })
        : ctx.orgId === null
          ? []
          : await listWorkItemsForOrg(ctx.orgId, { statuses, limit: MAX_ROWS });
      return project(rows as unknown as Array<Record<string, unknown>>, [
        'item_id', 'client_id', 'assignee_id', 'item_type', 'severity', 'title',
        'status', 'created_at', 'acked_at', 'resolved_at',
      ]);
    },
  },
  {
    name: 'caseload_roster',
    description:
      'The caller’s own caseload roster: per client, last session, session count, latest risk signal, open crisis/escalation counts, screener scores, safety-plan presence. Care-team roles only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    roles: ['therapist', 'caseworker'],
    run: async (ctx) => {
      const rows = await listCaseworkerRoster(ctx.userId);
      return project(rows as unknown as Array<Record<string, unknown>>, [
        'client_id', 'username', 'assigned_at', 'last_session_at', 'ended_session_count',
        'last_checkin_mood', 'latest_risk_score', 'latest_risk_severity', 'latest_risk_at',
        'open_crisis_count', 'latest_scales', 'open_escalation_count',
        'overdue_practice_count', 'has_safety_plan',
      ]);
    },
  },
  {
    name: 'user_lookup',
    description:
      'Look up participants by (partial) username: id, role, study status, created date. Care-team callers can only resolve clients on their caseload.',
    parameters: {
      type: 'object',
      properties: { username: { type: 'string', description: 'Exact or partial username' } },
      required: ['username'],
      additionalProperties: false,
    },
    roles: ['researcher', 'therapist', 'caseworker'],
    run: async (ctx, args) => {
      const q = String(args.username ?? '').trim().toLowerCase();
      if (!q) return [];
      const users = await getAllUsers();
      let matches = users.filter((u) => u.username.toLowerCase().includes(q));
      if (isCareTeamRole(ctx.role)) {
        const assigned = await Promise.all(matches.map((u) => isAssigned(ctx.userId, u.userid)));
        matches = matches.filter((_, i) => assigned[i]);
      }
      return project(matches as unknown as Array<Record<string, unknown>>, [
        'userid', 'username', 'role', 'study_status', 'created_at',
      ]);
    },
  },
];

function toolsFor(role: AssistantRole) {
  return TOOLS.filter((t) => t.roles.includes(role));
}

function toResponsesTools(role: AssistantRole): Array<Record<string, unknown>> {
  return toolsFor(role).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

function systemPrompt(ctx: AssistantContext): string {
  const toolNames = toolsFor(ctx.role).map((t) => t.name).join(', ');
  return [
    'You are the admin data assistant for a mental-health research platform. You answer staff questions strictly from the results of your tools, which run under the asker’s own access scope.',
    `The asker is ${ctx.username ?? 'a staff member'} with role "${ctx.role}". Available tools: ${toolNames}.`,
    'Rules:',
    '- Only state facts that appear in tool results. If the tools cannot answer, say so and name the panel that can.',
    '- You have no access to session transcripts, message bodies, or any verbatim participant text, for any role. If asked, explain that the assistant only works with aggregates, scores, and statuses.',
    '- Never speculate about clinical state or give clinical advice; point to the relevant clinician workflow instead.',
    '- Be concise. Use plain sentences or small markdown tables. No emojis.',
    '- End answers derived from data with a one-line note of which tools you used.',
  ].join('\n');
}

interface ResponsesOutputItem { type: string; call_id?: string; name?: string; arguments?: string }
interface ResponsesResult {
  output_text: string;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
}
type ResponsesClient = { responses: { create: (opts: Record<string, unknown>) => Promise<ResponsesResult> } };

let cachedClient: ResponsesClient | null = null;
async function getClient(): Promise<ResponsesClient> {
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey: await getOpenAIKey() }) as unknown as ResponsesClient;
  }
  return cachedClient;
}

/** Test seam. */
export function setAssistantClientForTest(client: ResponsesClient | null): void {
  cachedClient = client;
}

async function insertAudit(
  ctx: AssistantContext,
  question: string,
  tools: Array<{ name: string; args: Record<string, unknown>; row_count: number }>,
  usage: { input_tokens: number; output_tokens: number }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO assistant_audit (user_id, role, question, tools, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.userId, ctx.role, question.slice(0, 4000), JSON.stringify(tools), ASSISTANT_MODEL,
       usage.input_tokens, usage.output_tokens]
    );
  } catch (err) {
    log.error({ err }, 'assistant audit insert failed');
  }
}

export interface AssistantMessage { role: 'user' | 'assistant'; content: string }

/** One assistant turn: history + new question in, final text + tool trail out. */
export async function runAssistantTurn(
  ctx: AssistantContext,
  history: AssistantMessage[]
): Promise<AssistantTurnResult> {
  const client = await getClient();
  const roleTools = toolsFor(ctx.role);
  const tools = toResponsesTools(ctx.role);
  const question = history.filter((m) => m.role === 'user').at(-1)?.content ?? '';

  const input: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt(ctx) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const callModel = (toolChoice: 'auto' | 'none') =>
    client.responses.create({
      model: ASSISTANT_MODEL,
      input,
      store: false,
      tools,
      tool_choice: toolChoice,
    });

  const auditTools: Array<{ name: string; args: Record<string, unknown>; row_count: number }> = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const track = (r: ResponsesResult) => {
    usage.input_tokens += r.usage?.input_tokens ?? 0;
    usage.output_tokens += r.usage?.output_tokens ?? 0;
  };

  let response = await callModel('auto');
  track(response);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const calls = (response.output ?? []).filter((o) => o.type === 'function_call' && o.name && o.call_id);
    if (calls.length === 0) break;

    // Replay the raw output items verbatim: reasoning models emit sibling
    // reasoning items that must accompany their function_call (see
    // chatTherapy.service.ts for the long-form rationale).
    input.push(...((response.output ?? []) as unknown as Array<Record<string, unknown>>));

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        log.warn(`unparseable arguments for ${call.name}; running with {}`);
      }
      const tool = roleTools.find((t) => t.name === call.name);
      let output: unknown;
      if (!tool) {
        output = { error: `Tool ${call.name} is not available to the ${ctx.role} role.` };
        auditTools.push({ name: call.name!, args, row_count: 0 });
      } else {
        try {
          output = await tool.run(ctx, args);
          auditTools.push({ name: tool.name, args, row_count: rowCountOf(output) });
        } catch (err) {
          log.error({ err, tool: tool.name }, 'assistant tool failed');
          output = { error: 'This lookup failed; try the corresponding admin panel.' };
          auditTools.push({ name: tool.name, args, row_count: 0 });
        }
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) });
    }

    response = await callModel(round + 1 >= MAX_TOOL_ROUNDS ? 'none' : 'auto');
    track(response);
  }

  await insertAudit(ctx, question, auditTools, usage);
  return {
    answer: response.output_text || 'I could not produce an answer for that. Try rephrasing, or use the relevant admin panel.',
    toolCalls: auditTools.map((t) => ({ name: t.name, rowCount: t.row_count })),
  };
}
