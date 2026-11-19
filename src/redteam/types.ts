// Shared types for the scripted red-team safety harness (spec §3.1, §4).
import type { EvalDimensionId } from '../server/services/sessionEval.service.js';
import type { KnownGap } from './knownGap.js';
import type { ProgressionMetrics } from './progression.js';
import type { CostBreakdown } from './config.js';
import type { VoiceEvalSpec } from './voice/scenarioTypes.js';
import type { RunMetrics } from './voice/metrics.js';
import type { HarnessClient } from './harnessClient.js';

export type { EvalDimensionId };

/** Every dimension a red-team judge result can carry: the v1 rubric plus the
 *  harness-only, report-only session_progression (progressionJudge.ts).
 *  judgeMinScores stays typed to EvalDimensionId, so no scenario can put a
 *  gating floor on session_progression. */
export type JudgeDimensionId = EvalDimensionId | 'session_progression';

/** Which pipeline a scenario drives. `chat` → /api/chat/*; `realtime-text` →
 *  POST participant turns to /logs/batch (the only HTTP path with real crisis
 *  detection); `voice` → a real voice session on the production backend
 *  selected by system_config.ai_model (today the Grok proxy), with TTS persona
 *  audio + a playable session recording (ai-therapist-124/213). In dry-run,
 *  voice scenarios fall back to the realtime-text flow. `assistant` → the
 *  ADMIN data assistant (POST /admin/api/assistant/chat) driven as a logged-in
 *  staff user of `Scenario.assistantRole` (ai-therapist-207): the persona is a
 *  staff member, not a participant, and the thing under test is role scoping,
 *  injection resistance and data exfiltration, not therapy quality. `http` →
 *  no conversation at all: the scenario's `httpProbe` drives the real routes
 *  (session-start gates, RBAC, audit rows) and its `assertFinal` checks read
 *  what the probe recorded (`AssertionContext.http`). Judge-free and
 *  model-free by construction; it runs the same under --dry-run. */
export type Pipeline = 'chat' | 'realtime-text' | 'voice' | 'assistant' | 'http';

/** One HTTP call an `http` scenario made, as the assertions see it. */
export interface HttpStep {
  status: number;
  body: unknown;
}

/** What an `http` scenario's probe recorded: every call by a stable key, plus
 *  database facts read along the way (row counts, ids, timestamps). */
export interface HttpProbeRecord {
  steps: Record<string, HttpStep>;
  facts: Record<string, unknown>;
}

/** What the runner hands an `http` scenario's probe. */
export interface HttpProbeEnv {
  client: HarnessClient;
  pool: DbLike;
  dryRun: boolean;
}

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
  /** Multi-session scenarios only: the `SessionSpec.id` this turn belongs to,
   *  so the combined transcript in summary.json can be read session by session. */
  session?: string;
  /** GPT-Live voice runs only: which layer produced this assistant turn, read
   *  from the data channel. `voice` = the voice model answered on its own (no
   *  delegation started in the turn's window); `delegated` = the voice model
   *  handed the turn to the clinical backend (session.delegation.created).
   *  Absent on every other pipeline. */
  layer?: TurnLayer;
  /** GPT-Live: the voice model spoke before the delegation started (a preface
   *  or acknowledgement of its own ahead of the backend's answer). */
  voiceSpokeFirst?: boolean;
  /** GPT-Live: what the delegated backend returned for this turn (the voice
   *  model speaks it, possibly paraphrased). */
  backendText?: string;
  /** GPT-Live: tools the delegated backend called during this turn. */
  tools?: string[];
}

export type TurnLayer = 'voice' | 'delegated';

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
  /** Multi-session scenarios only (multiSession.ts): every session the
   *  scenario has started so far, in order, the current one last. `sessionId`
   *  and `transcript` above are the CURRENT session's, so single-session
   *  assertions work unchanged inside any one session. */
  sessions?: SessionRecord[];
  /** Set on the http pipeline only: what the scenario's probe recorded. */
  http?: HttpProbeRecord;
  pool: DbLike;
  classify: ClassifyFn;
  dryRun: boolean;
}

export interface AssertionResult {
  id: string;
  passed: boolean;
  detail: string;
  gating: boolean;
  /** Flightdeck ref when this assertion is a listed known gap (knownGap.ts). */
  knownGap?: string;
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
  /** GPT-Live voice evaluation (src/redteam/voice): what this turn should do
   *  at the voice/backend boundary. `delegate` follows the guide's
   *  required | forbidden | optional; `crisis` marks a crisis turn for the
   *  latency and silence-during-delegation breakdown. */
  voice?: { delegate?: 'required' | 'forbidden' | 'optional'; crisis?: boolean };
}

/** A fresh account a multi-session scenario runs as. Created per run with a
 *  reserved userid (participantIdentity.ts), so nothing carries over between
 *  runs and no probe is attributable to a real participant's identifier. */
export interface ParticipantSpec {
  /** users.memory_enabled at creation (the participant's own consent to
   *  cross-session memory; the product default is off). */
  memoryEnabled: boolean;
  /** users.risk_context_share_enabled (a therapist's opt-in to share prior
   *  crisis history with the AI; research participants do not have it). */
  riskContextShare?: boolean;
}

/** What a session hook can reach. Hooks seed state a scenario needs (a
 *  clinician note, a memory toggle through the real route) or act as the
 *  participant's browser would (posting a completed screener). */
export interface SessionHookEnv {
  pool: DbLike;
  dryRun: boolean;
  /** Every participant the scenario declared, by key. */
  participants: Record<string, { userId: number; username: string }>;
  /** The participant this session belongs to. */
  userId: number;
  /** Unset in `before` (the session has not started yet). */
  sessionId?: string;
  /** Sessions so far, the current one last once it has started. */
  sessions: SessionRecord[];
  /** An authenticated request as this session's participant. */
  request: (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  /** Record something for assertions to read (`SessionRecord.observations`).
   *  In `before` it lands on the session about to start. */
  observe: (key: string, value: unknown) => void;
}

/** One session of a multi-session chat scenario. */
export interface SessionSpec {
  id: string;
  /** Key into `Scenario.participants`. Default: the first one declared. */
  participant?: string;
  /** Days between this participant's previous activity and this session. The
   *  harness cannot move the server's clock, so it moves the past instead:
   *  every row belonging to this participant is aged by this many days before
   *  the session starts (multiSession.ts `ageParticipantHistory`). Everything
   *  the server computes against now() (dates in the memory block, the
   *  seven-day screener window, "since last session") then sees the gap. */
  daysSincePrevious?: number;
  /** Pre-session check-in, sent with /api/chat/start as the client sends it. */
  checkin?: ScenarioCheckin;
  beats: Beat[];
  /** Runs before the session starts (after any ageing). */
  before?: (env: SessionHookEnv) => Promise<void>;
  /** Runs after the last beat while the session is still active. */
  beforeEnd?: (env: SessionHookEnv) => Promise<void>;
  /** Run once the session has ended and its post-session jobs (summary, case
   *  profile) have settled, so they can read what the next session will get. */
  assertAfter?: AssertionSpec[];
}

/** What the harness recorded about one session of a multi-session scenario. */
export interface SessionRecord {
  /** `SessionSpec.id`. */
  id: string;
  sessionId: string;
  /** Key into `Scenario.participants`. */
  participant: string;
  userId: number;
  username: string;
  /** The server-authored opening line, as /api/chat/start returned it. */
  opening: string | null;
  /** The assembled system prompt the session ran on
   *  (session_configurations.instructions): base prompt plus memory block
   *  plus check-in. This is what was BUILT for the participant. */
  systemPrompt: string;
  transcript: Turn[];
  /** session_insights.summary once the post-session job has written it
   *  (null in dry-run and until the session has ended). */
  summary: Record<string, unknown> | null;
  /** Whatever the scenario's hooks recorded with `observe`. */
  observations: Record<string, unknown>;
}

/** The optional pre-session check-in a participant fills in before a chat
 *  session (mood slider, "what's on your mind", "what do you want from
 *  today"). Sent as `checkin` on /api/chat/start, exactly as the client does. */
export interface ScenarioCheckin {
  mood?: number;
  topic?: string;
  goal?: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** docs/eval-scenario-catalogue.md ids this scenario covers (e.g. GATE-01). */
  catalogueIds?: string[];
  pipeline: Pipeline;
  /** Chat pipeline: the scenario spans these sessions, in order
   *  (multiSession.ts). `beats` must then be the sessions' beats flattened
   *  (use `multiSessionScenario`), so everything that walks `beats` still
   *  sees every assertion. */
  sessions?: SessionSpec[];
  /** Accounts `sessions` run as, by key. Required with `sessions`. */
  participants?: Record<string, ParticipantSpec>;
  /** Chat pipeline: the pre-session check-in to submit with /api/chat/start. */
  checkin?: ScenarioCheckin;
  modality?: string;
  /** Test-only fault or fixture installed around the run and undone after it,
   *  pass or fail (e.g. the risk assessor made unreachable). Lives in the
   *  harness process and its disposable database only. */
  fixture?: (env: { pool: DbLike; dryRun: boolean }) => Promise<() => Promise<void>>;
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
  /** Voice pipeline on GPT-Live only: after the last beat, send the data-channel
   *  client events a participant's browser must not be able to use (a backend
   *  prompt rewrite, a forged tool result, a response override) and assert the
   *  API refuses each one. See liveVoiceChecks.ts. */
  liveClientProbes?: boolean;
  /** A known, filed product gap this scenario is expected to fail on. The
   *  scenario stays in its suite and its assertions stay gating (a known gap
   *  is not a pass); reports name the gap so a new failure stands out.
   *  With `assertionIds`, exactly those assertions are reported in the
   *  KNOWN GAPS block without gating, and every other assertion still
   *  gates (knownGap.ts). */
  knownGap?: KnownGap;
  /** Do not run unless the harness participant has a reserved userid, so the
   *  probes cannot be attributed to a real participant's OpenAI safety
   *  identifier (participantIdentity.ts, ai-therapist-306). */
  requiresReservedParticipant?: boolean;
  /** Chat pipeline: log in as this participant instead of the shared
   *  redteam_participant (e.g. a returning participant with seeded history,
   *  so per-user memory never leaks into other scenarios). */
  participant?: { username: string; password: string };
  /** Seed what the scenario needs before it starts (idempotent; runs against
   *  the harness DB, also in dry-run). */
  setup?: (pool: DbLike) => Promise<void>;
  /** Undo `setup` after the scenario, pass or fail. */
  teardown?: (pool: DbLike) => Promise<void>;
  /** GPT-Live voice evaluation mode (src/redteam/voice, docs/redteam.md
   *  "GPT-Live evaluation guide"). Absent = an ordinary voice scenario. */
  voiceEval?: VoiceEvalSpec;
  /** Required on the http pipeline: drive the real routes and record what
   *  came back for `assertFinal` to check. Must never call a model. */
  httpProbe?: (env: HttpProbeEnv) => Promise<HttpProbeRecord>;
}

export interface JudgeScores {
  /** Consensus (median) scores — what floors and diffs are evaluated on. */
  scores: Partial<Record<JudgeDimensionId, number>>;
  overall: string | null;
  /** Judge label stored on the session_evals row (model id or ensemble(...)). */
  judgeModel?: string;
  /** Raw per-judge scores behind the consensus, keyed `model` or `model#run`. */
  perJudge?: Record<string, Partial<Record<JudgeDimensionId, number>>>;
  /** Per-dimension max-min across judge runs (null/absent for one judge). */
  spread?: Record<string, number> | null;
  /** session_progression rationale from the first judge run that scored it. */
  progressionRationale?: string;
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
  /** Deterministic session-progression metrics (chat pipeline only; report-only). */
  progression?: ProgressionMetrics | null;
  /** Total spend attributed to the scenario (= cost.totalUsd when present). */
  costUsd: number;
  /** Where costUsd came from: per category, recorded vs estimated. */
  cost?: CostBreakdown;
  durationMs: number;
  error?: string;
  /** Set only on LLM-generated adversarial variants (--generated-variants,
   *  ai-therapist-109). Their id is `gen:<parent>:<operator>:s<seed>`; they are
   *  reported separately, excluded from baseline diffs and the harness_runs
   *  table, and count toward the exit code only when `gating` is true. */
  generated?: GeneratedVariantMeta;
  /** GPT-Live runs: the guide's audio, delegation and consumption metrics
   *  (src/redteam/voice/metrics.ts). */
  voiceMetrics?: RunMetrics;
  /** The scenario's knownGap declaration, carried into summary.json so a
   *  label-only gap (no assertionIds) is recognisable from the artifact
   *  (flightdeckReport.ts files nothing for it). */
  knownGap?: KnownGap;
}

export interface GeneratedVariantMeta {
  parentId: string;
  operator: string;
  seed: number;
  /** --gate-generated: false (the default) keeps a failure out of the exit code. */
  gating: boolean;
  /** Loaded from the variant cache instead of generated this run. */
  cached: boolean;
  /** Persisted script in the run directory; replay with --variant-cache <its dir>. */
  scriptFile: string;
}
