// Shared types for the scripted red-team safety harness (spec §3.1, §4).
import type { EvalDimensionId } from '../server/services/sessionEval.service.js';

export type { EvalDimensionId };

/** Which pipeline a scenario drives. `chat` → /api/chat/*; `realtime-text` →
 *  POST participant turns to /logs/batch (the only HTTP path with real crisis
 *  detection); `voice` → a real voice session on the production backend
 *  selected by system_config.ai_model (today the Grok proxy), with TTS persona
 *  audio + a playable session recording (ai-therapist-124/213). In dry-run,
 *  voice scenarios fall back to the realtime-text flow. `assistant` → the
 *  ADMIN data assistant (POST /admin/api/assistant/chat) driven as a logged-in
 *  staff user of `Scenario.assistantRole` (ai-therapist-207): the persona is a
 *  staff member, not a participant, and the thing under test is role scoping,
 *  injection resistance and data exfiltration, not therapy quality. */
export type Pipeline = 'chat' | 'realtime-text' | 'voice' | 'assistant';

/** Staff roles the admin assistant serves (mirrors assistant.service.ts). */
export type AssistantRole = 'therapist' | 'researcher' | 'caseworker';

/** Assistant-pipeline state exposed to assertions: what the endpoint said it
 *  ran this turn, and who asked, so DB assertions can bind to assistant_audit. */
export interface AssistantTurnState {
  /** Role the current beat ran as. */
  role: AssistantRole;
  /** users.userid of the staff account the beat ran as. */
  userId: number;
  /** The beat's question exactly as POSTed (assistant_audit.question). */
  question: string;
  /** Tool trail returned by the endpoint for the current turn. */
  toolCalls: Array<{ name: string; rowCount: number }>;
  /** Every (role, userId) the scenario has driven so far, for final checks. */
  callers: Array<{ role: AssistantRole; userId: number }>;
  /** Wall-clock start of the scenario: audit rows before it are not ours. */
  startedAt: Date;
}

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
  /** Majority vote over this many seeded runs (default 1). Use an odd count
   *  (e.g. 3) on assertions known to flake on classifier nondeterminism. */
  votes?: number;
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
  /** Set on the assistant pipeline only. */
  assistant?: AssistantTurnState;
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
  /** Assistant pipeline only: run this beat as a different staff role than
   *  `Scenario.assistantRole` (each role keeps its own login + history). */
  assistantRole?: AssistantRole;
  assertAfter?: AssertionSpec[];
}

export interface Scenario {
  id: string;
  title: string;
  pipeline: Pipeline;
  modality?: string;
  /** Assistant pipeline: the staff role the scenario logs in as. */
  assistantRole?: AssistantRole;
  personaSystem: string;
  /** Persona style modifiers for `--variations k` (ai-therapist-124 phase 3):
   *  variation v>0 appends styles[(v-1) % len] to personaSystem and shifts the
   *  seed. Omitted → the shared DEFAULT_VARIATION_STYLES pool. Verbatim beats
   *  stay verbatim (they're deterministic checkpoints by design). */
  variationStyles?: string[];
  beats: Beat[];
  assertFinal?: AssertionSpec[];
  runJudge: boolean;
  judgeMinScores?: Partial<Record<EvalDimensionId, number>>;
}

export interface JudgeScores {
  /** Consensus (median) scores — what floors and diffs are evaluated on. */
  scores: Partial<Record<EvalDimensionId, number>>;
  overall: string | null;
  /** Judge label stored on the session_evals row (model id or ensemble(...)). */
  judgeModel?: string;
  /** Raw per-judge scores behind the consensus, keyed `model` or `model#run`. */
  perJudge?: Record<string, Partial<Record<EvalDimensionId, number>>>;
  /** Per-dimension max-min across judge runs (null/absent for one judge). */
  spread?: Record<string, number> | null;
}

export interface ScenarioResult {
  /** Base scenario id, suffixed `#v2`, `#v3`, … for variations beyond the first. */
  id: string;
  title: string;
  pipeline: Pipeline;
  /** 0-based variation index (0 = the canonical persona). */
  variation: number;
  passed: boolean;
  assertions: AssertionResult[];
  judge: JudgeScores | null;
  /** The therapy session the scenario drove — links results to the transcript
   *  and (voice) the playable recording. Unset when the run failed pre-session. */
  sessionId?: string;
  /** The conversation the harness drove (persona turns + assistant replies, in
   *  order, server-authored opening first). Carried in summary.json so a CI
   *  failure can be triaged from the artifact: the CI database is gone by the
   *  time anyone reads the result. Synthetic persona text only. */
  transcript?: Turn[];
  costUsd: number;
  durationMs: number;
  error?: string;
}
