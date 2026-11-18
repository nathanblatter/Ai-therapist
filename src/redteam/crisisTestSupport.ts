// Shared scaffolding for the crisis assertion tests (offline unit tests and
// the opt-in live rubric calibration). Not used by the harness itself.
import type { AssertionContext, CapturedEmission, ClassifyFn, ClassifyRequest, DbLike, Turn } from './types.js';

export const A = (text: string, beatId?: string): Turn => ({ role: 'assistant', text, beatId });
export const U = (text: string, beatId?: string): Turn => ({ role: 'user', text, beatId });

/** The server-authored first turn every chat session opens with. */
export const OPENING = A(
  "Hello! I'm an AI mental health support assistant. I am not a licensed therapist or doctor. " +
    "If you're in crisis, you should call the 988 Suicide & Crisis Lifeline at 988 or text HOME to 741741.",
  'opening',
);

export interface RiskRowFixture {
  risk_score: number;
  method: string | null;
  keyword_score: number | null;
}

export interface PoolFixture {
  /** therapy_sessions.status; null means no row. */
  status?: string | null;
  endedBy?: string | null;
  flagged?: boolean;
  flaggedSeverity?: string | null;
  /** tool name -> number of tool_call rows. */
  toolCalls?: Record<string, number>;
  /** action_type -> number of intervention_actions rows. */
  interventions?: Record<string, number>;
  /** Rows for the action_details scan. */
  interventionRows?: Array<{ action_type: string; details: string }>;
  risk?: RiskRowFixture[];
}

/** A DbLike that answers the queries crisisAssertions.ts makes. */
export function poolOf(f: PoolFixture = {}): DbLike {
  return {
    query: async (text: string, params: unknown[] = []) => {
      if (text.includes('risk_score_history'))
        return { rows: (f.risk ?? []) as unknown as Array<Record<string, unknown>> };
      if (text.includes("message_type = 'tool_call'")) {
        return { rows: [{ n: f.toolCalls?.[String(params[1])] ?? 0 }] };
      }
      if (text.includes('action_details::text')) return { rows: f.interventionRows ?? [] };
      if (text.includes('intervention_actions')) {
        return { rows: [{ n: f.interventions?.[String(params[1])] ?? 0 }] };
      }
      if (text.includes('crisis_severity')) {
        return { rows: [{ crisis_flagged: f.flagged ?? false, crisis_severity: f.flaggedSeverity ?? null }] };
      }
      if (text.includes('therapy_sessions')) {
        return { rows: f.status === null ? [] : [{ status: f.status ?? 'active', ended_by: f.endedBy ?? null }] };
      }
      return { rows: [] };
    },
  };
}

export interface CtxOptions {
  transcript?: Turn[];
  latestReply?: string;
  /** Fixed verdict for the mocked classifier. */
  classifyVerdict?: boolean;
  /** Replace the classifier entirely (the live calibration passes a real one). */
  classify?: ClassifyFn;
  pool?: DbLike;
  emissions?: CapturedEmission[];
  chatSessionEnded?: boolean;
  sessionId?: string;
  dryRun?: boolean;
}

/** An AssertionContext plus a record of every classifier request made, so a
 *  test can prove a regex layer settled the case without asking the model. */
export function ctxOf(opts: CtxOptions = {}): AssertionContext & { classifyCalls: ClassifyRequest[] } {
  const classifyCalls: ClassifyRequest[] = [];
  const transcript = opts.transcript ?? [];
  const lastAssistant = [...transcript].reverse().find((t) => t.role === 'assistant');
  const classify: ClassifyFn = async (req) => {
    classifyCalls.push(req);
    if (opts.classify) return opts.classify(req);
    return { verdict: opts.classifyVerdict ?? false, evidence: 'mock' };
  };
  return {
    scenarioId: 'test',
    sessionId: opts.sessionId ?? 's1',
    latestReply: opts.latestReply ?? lastAssistant?.text ?? '',
    transcript,
    emissions: opts.emissions ?? [],
    beatPostTimes: {},
    systemPromptCanaries: [],
    chatSessionEnded: opts.chatSessionEnded,
    pool: opts.pool ?? poolOf(),
    classify,
    dryRun: opts.dryRun ?? false,
    classifyCalls,
  };
}
