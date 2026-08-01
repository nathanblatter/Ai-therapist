// Shared types for the scripted red-team safety harness (spec §3.1, §4).
import type { EvalDimensionId } from '../server/services/sessionEval.service.js';

export type { EvalDimensionId };

/** Which pipeline a scenario drives. `chat` → /api/chat/*; `realtime-text` →
 *  POST participant turns to /logs/batch (the only path with real crisis
 *  detection). See spec §1c. */
export type Pipeline = 'chat' | 'realtime-text';

export type Severity = 'none' | 'low' | 'medium' | 'high';

export const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Map a 0-100 risk score to a band using the SAME thresholds as prod
 *  (crisisDetection.service.ts). */
export function scoreToBand(score: number): Severity {
  return score >= 75 ? 'high' : score >= 50 ? 'medium' : score >= 25 ? 'low' : 'none';
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  beatId?: string;
}

export interface CapturedEmission {
  room: string;
  event: string;
  payload: unknown;
  ts: Date;
}

export interface ClassifyRequest {
  /** Versioned classifier-prompt id so results stay comparable. */
  version: string;
  /** The yes/no question the temp-0 classifier answers about `text`. */
  question: string;
  text: string;
}
export interface ClassifyResult {
  verdict: boolean;
  evidence: string;
}
export type ClassifyFn = (req: ClassifyRequest) => Promise<ClassifyResult>;

/** Minimal DB surface an assertion needs (satisfied by pg's Pool, or a mock). */
export interface DbLike {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface AssertionContext {
  scenarioId: string;
  sessionId: string;
  /** Set when the assertion runs immediately after a specific beat. */
  beatId?: string;
  /** The assistant's most recent reply text (chat pipeline). Empty on the
   *  realtime-text pipeline where the harness posts only participant turns. */
  latestReply: string;
  /** Full conversation so far, in order. */
  transcript: Turn[];
  /** Socket emissions captured in-process (spec §5). */
  emissions: CapturedEmission[];
  /** Wall-clock time each beat's participant turn was posted (for ordering). */
  beatPostTimes: Record<string, Date>;
  /** Canary substrings drawn from the real system prompt (spec §4 contextNotLeaked). */
  systemPromptCanaries: string[];
  /** True when the most recent chat-pipeline reply came back with
   *  `sessionEnded: true` (e.g. the eligibility gate ended the session). */
  chatSessionEnded?: boolean;
  /** HTTP status + body of the most recent chat-message POST when a beat is
   *  marked `expectInactive` (the harness sends it raw instead of throwing). */
  lastMessageStatus?: number;
  lastMessageBody?: unknown;
  pool: DbLike;
  classify: ClassifyFn;
  dryRun: boolean;
}

export interface AssertionResult {
  id: string;
  passed: boolean;
  detail: string;
  gating: boolean;
}

export interface AssertionSpec {
  id: string;
  /** Whether a failure fails the scenario (and the deploy gate). Default true. */
  gating?: boolean;
  run: (ctx: AssertionContext) => Promise<AssertionResult>;
}

export interface Beat {
  id: string;
  personaGoal: string;
  /** Literal override sent verbatim instead of asking the persona LLM. */
  verbatim?: string;
  /** Chat pipeline only: expect /api/chat/message to be REJECTED for this turn
   *  (e.g. the session was ended by the eligibility gate on a prior beat). The
   *  harness sends the message raw (no throw on non-200) and exposes the status
   *  + body on the assertion context; no assistant turn is recorded. */
  expectInactive?: boolean;
  assertAfter?: AssertionSpec[];
}

export interface Scenario {
  id: string;
  title: string;
  pipeline: Pipeline;
  modality?: string;
  personaSystem: string;
  beats: Beat[];
  assertFinal?: AssertionSpec[];
  runJudge: boolean;
  judgeMinScores?: Partial<Record<EvalDimensionId, number>>;
}

export interface JudgeScores {
  scores: Partial<Record<EvalDimensionId, number>>;
  overall: string | null;
}

export interface ScenarioResult {
  id: string;
  title: string;
  pipeline: Pipeline;
  passed: boolean;
  assertions: AssertionResult[];
  judge: JudgeScores | null;
  costUsd: number;
  durationMs: number;
  error?: string;
}
