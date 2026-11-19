// Multi-session chat scenarios: one scenario, two or more sessions for the
// same participant (or for several participants), optionally "dated N days
// apart". docs/redteam.md, "Multi-session scenarios".
//
// What is real and what is not:
//
//   - Every session is a real /api/chat/start ... /api/chat/end, and the wait
//     between sessions is for the product's own post-session job
//     (sessionInsights.service) to write the summary the next session's memory
//     block is built from. Nothing is copied from one session to the next by
//     the harness.
//   - The gap between sessions is produced by AGEING THE PAST, not by moving
//     the clock: before a session with `daysSincePrevious: n` starts, every
//     timestamp on every row belonging to that participant is moved back n
//     days. The server only ever compares stored times with now(), so a
//     summary that ended "8 days ago" is one whose ended_at is 8 days old.
//   - Each scenario runs as accounts created for that run, with reserved
//     userids (participantIdentity.ts). Ageing refuses any other userid, so it
//     can never touch a real participant's rows wherever the harness is
//     pointed.
import bcrypt from 'bcrypt';
import type OpenAI from 'openai';
import type { CostTracker, RedteamConfig } from './config.js';
import type { Agent, HarnessClient } from './harnessClient.js';
import { RESERVED_PARTICIPANT_USERID_MIN } from './participantIdentity.js';
import { applyKnownGap, type KnownGap } from './knownGap.js';
import { generatePersonaTurn } from './personaDriver.js';
import { checkVariantApplied, getVariant } from './variants.js';
import type {
  AssertionContext,
  AssertionResult,
  AssertionSpec,
  DbLike,
  ParticipantSpec,
  Scenario,
  SessionHookEnv,
  SessionRecord,
  SessionSpec,
  Turn,
} from './types.js';

/** Userids for accounts this module creates. Above the shared harness
 *  participant (1900000042, scripts/redteam-seed-user.mjs) and inside the
 *  reserved range. */
export const MULTI_SESSION_USERID_MIN = RESERVED_PARTICIPANT_USERID_MIN + 1_000_000;
export const MULTI_SESSION_PASSWORD = 'redteam-Passw0rd!';
export const MULTI_SESSION_USERNAME_PREFIX = 'redteam_ms_';

/** How long to wait for the post-session summary before going on without it.
 *  The job normally lands within fifteen seconds. */
const SUMMARY_WAIT_MS = 60_000;

type ScenarioShape = Omit<Scenario, 'beats' | 'pipeline' | 'sessions' | 'participants'> & {
  sessions: SessionSpec[];
  participants: Record<string, ParticipantSpec>;
};

/**
 * Declare a multi-session chat scenario. `beats` is filled with the sessions'
 * beats flattened, so the code that walks `Scenario.beats` (known-gap
 * validation, suite tests) sees every beat. Beat ids must be unique across the
 * sessions for that reason.
 */
export function multiSessionScenario(shape: ScenarioShape): Scenario {
  return { ...shape, pipeline: 'chat', beats: shape.sessions.flatMap((s) => s.beats) };
}

/**
 * Multi-session scenarios create accounts and age their rows, so they run
 * only against a disposable database. The in-app runner
 * (harnessRunner.service.ts, which sets REDTEAM_TRIGGER) runs the CLI against
 * the deployment's own database: there they are left out, and the run says so.
 */
export function withoutMultiSession<T extends { scenario: Scenario }>(
  entries: T[],
  trigger: string | undefined,
): { kept: T[]; skipped: string[] } {
  if (!trigger) return { kept: entries, skipped: [] };
  return {
    kept: entries.filter((e) => !e.scenario.sessions),
    skipped: entries.filter((e) => e.scenario.sessions).map((e) => e.scenario.id),
  };
}

/** Problems with a multi-session declaration; empty when it is well formed. */
export function validateMultiSession(scenario: Scenario): string[] {
  const problems: string[] = [];
  const sessions = scenario.sessions;
  if (!sessions) return problems;
  const keys = Object.keys(scenario.participants ?? {});
  if (scenario.pipeline !== 'chat') problems.push(`${scenario.id}: multi-session scenarios run on the chat pipeline`);
  if (sessions.length === 0) problems.push(`${scenario.id}: no sessions`);
  if (scenario.runJudge)
    problems.push(`${scenario.id}: the judge scores one session; multi-session scenarios do not run it`);
  if (keys.length === 0) problems.push(`${scenario.id}: no participants declared`);
  const sessionIds = sessions.map((s) => s.id);
  if (new Set(sessionIds).size !== sessionIds.length) problems.push(`${scenario.id}: duplicate session id`);
  const beatIds = sessions.flatMap((s) => s.beats.map((b) => b.id));
  if (new Set(beatIds).size !== beatIds.length)
    problems.push(`${scenario.id}: beat ids must be unique across sessions`);
  if (scenario.beats.length !== beatIds.length || scenario.beats.some((b, i) => b.id !== beatIds[i]))
    problems.push(`${scenario.id}: beats is not the sessions' beats flattened (use multiSessionScenario)`);
  const seen = new Set<string>();
  for (const s of sessions) {
    const key = s.participant ?? keys[0];
    if (!keys.includes(key)) problems.push(`${scenario.id}/${s.id}: unknown participant '${key}'`);
    if (s.daysSincePrevious !== undefined) {
      if (!Number.isInteger(s.daysSincePrevious) || s.daysSincePrevious <= 0)
        problems.push(`${scenario.id}/${s.id}: daysSincePrevious must be a positive whole number`);
      if (!seen.has(key))
        problems.push(`${scenario.id}/${s.id}: daysSincePrevious on a participant's first session ages nothing`);
    }
    if (s.beats.length === 0) problems.push(`${scenario.id}/${s.id}: a session needs at least one beat`);
    seen.add(key);
  }
  return problems;
}

/** Every assertion a scenario declares, wherever it sits (beats, sessions, final). */
export function declaredAssertions(scenario: Pick<Scenario, 'beats' | 'assertFinal' | 'sessions'>): AssertionSpec[] {
  return [
    ...scenario.beats.flatMap((b) => b.assertAfter ?? []),
    ...(scenario.sessions ?? []).flatMap((s) => s.assertAfter ?? []),
    ...(scenario.assertFinal ?? []),
  ];
}

export interface CreatedParticipant {
  userId: number;
  username: string;
}

/** Create a fresh participant account in the reserved userid range. */
export async function createParticipant(
  pool: DbLike,
  scenarioId: string,
  key: string,
  spec: ParticipantSpec,
): Promise<CreatedParticipant> {
  const hash = await bcrypt.hash(MULTI_SESSION_PASSWORD, 4);
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const username = `${MULTI_SESSION_USERNAME_PREFIX}${scenarioId}_${key}_${tag}`.slice(0, 200);
  // One eval process at a time, so MAX+1 does not race; a collision would
  // fail on the primary key rather than reuse an account.
  const { rows } = await pool.query(
    `INSERT INTO users (userid, username, password, role, organization_id, memory_enabled, risk_context_share_enabled)
     VALUES ((SELECT GREATEST(COALESCE(MAX(userid), 0), $1::int - 1) + 1 FROM users WHERE userid >= $1::int),
             $2, $3, 'participant', (SELECT org_id FROM organizations WHERE slug = 'irb-study'), $4, $5)
     RETURNING userid`,
    [MULTI_SESSION_USERID_MIN, username, hash, spec.memoryEnabled, spec.riskContextShare === true],
  );
  const userId = Number(rows[0]?.userid);
  if (!Number.isFinite(userId) || userId < MULTI_SESSION_USERID_MIN)
    throw new Error(`multi-session participant '${key}' was not created with a reserved userid`);
  return { userId, username };
}

/** Tables never aged: spend rows are read by session id for cost and must keep
 *  their real times, and the express session store is not participant data. */
const AGE_SKIP_TABLES = new Set(['session_llm_usage', 'live_usage', 'realtime_usage', 'user_sessions', 'users']);

export interface AgeableTable {
  table: string;
  hasSessionId: boolean;
  hasUserId: boolean;
  timestampColumns: string[];
}

/** Every table that holds per-session or per-user rows with a timestamp, read
 *  from the schema so a table added by a later migration is aged too. */
export async function ageableTables(pool: DbLike): Promise<AgeableTable[]> {
  const { rows } = await pool.query(
    `SELECT c.table_name AS table,
            bool_or(c.column_name = 'session_id' AND c.data_type IN ('text', 'character varying')) AS has_session_id,
            bool_or(c.column_name = 'user_id' AND c.data_type = 'integer') AS has_user_id,
            array_agg(c.column_name::text ORDER BY c.column_name)
              FILTER (WHERE c.data_type LIKE 'timestamp%') AS ts
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
      GROUP BY c.table_name`,
  );
  return rows
    .map((r) => ({
      table: String(r.table),
      hasSessionId: r.has_session_id === true,
      hasUserId: r.has_user_id === true,
      timestampColumns: Array.isArray(r.ts) ? (r.ts as string[]) : [],
    }))
    .filter((t) => (t.hasSessionId || t.hasUserId) && t.timestampColumns.length > 0 && !AGE_SKIP_TABLES.has(t.table))
    .sort((a, b) => a.table.localeCompare(b.table));
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** The UPDATE that ages one table's rows for one participant. Exported for the
 *  unit test; identifiers come from information_schema and are still checked. */
export function ageTableSql(t: AgeableTable): string {
  for (const name of [t.table, ...t.timestampColumns]) {
    if (!IDENT.test(name)) throw new Error(`refusing to age: unexpected identifier '${name}'`);
  }
  const sets = t.timestampColumns.map((c) => `${c} = ${c} - make_interval(days => $1::int)`).join(', ');
  const where = [
    t.hasSessionId ? 'session_id IN (SELECT session_id FROM therapy_sessions WHERE user_id = $2::int)' : null,
    t.hasUserId ? 'user_id = $2::int' : null,
  ]
    .filter(Boolean)
    .join(' OR ');
  return `UPDATE ${t.table} SET ${sets} WHERE ${where}`;
}

/**
 * Move everything this participant has on record `days` days into the past.
 * Refuses a userid outside the range this module creates accounts in.
 */
export async function ageParticipantHistory(pool: DbLike, userId: number, days: number): Promise<void> {
  if (!Number.isInteger(userId) || userId < MULTI_SESSION_USERID_MIN)
    throw new Error(`refusing to age the history of userid ${userId}: not an account this harness created`);
  if (!Number.isInteger(days) || days <= 0) throw new Error(`cannot age history by ${days} days`);
  for (const t of await ageableTables(pool)) {
    await pool.query(ageTableSql(t), [days, userId]);
  }
}

/** The assembled prompt a session ran on. Empty if the row is missing. */
export async function readSystemPrompt(pool: DbLike, sessionId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT instructions FROM session_configurations WHERE session_id = $1`, [
    sessionId,
  ]);
  return typeof rows[0]?.instructions === 'string' ? (rows[0].instructions as string) : '';
}

/**
 * Wait for the post-session job to store this session's summary and, for a
 * participant with memory on, to update the case profile it writes right
 * after. The next session's memory block reads both.
 *
 * Returns null when no summary appears. That is a product outcome, not a
 * harness error: see SUMMARY_LOSS_GAP and summaryStoredResult.
 */
export async function waitForSummary(
  pool: DbLike,
  sessionId: string,
  opts: { timeoutMs?: number; pollMs?: number; expectCaseProfileFor?: number | null; profileGraceMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const timeoutMs = opts.timeoutMs ?? SUMMARY_WAIT_MS;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  // The case profile is optional output of the same model call, written just
  // after the summary: give it a short grace period, then move on without it.
  let profileDeadline: number | null = null;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT summary, created_at FROM session_insights WHERE session_id = $1 AND summary IS NOT NULL`,
      [sessionId],
    );
    if (rows[0]?.summary && typeof rows[0].summary === 'object') {
      const summary = rows[0].summary as Record<string, unknown>;
      if (!opts.expectCaseProfileFor) return summary;
      const profile = await pool.query(`SELECT 1 FROM user_case_profiles WHERE user_id = $1 AND updated_at >= $2`, [
        opts.expectCaseProfileFor,
        rows[0].created_at,
      ]);
      if (profile.rows.length > 0) return summary;
      profileDeadline ??= Date.now() + (opts.profileGraceMs ?? 5000);
      if (Date.now() > profileDeadline) return summary;
    } else if (Date.now() > deadline) {
      return null;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A product gap the runner itself reports, for every session of every
 * multi-session scenario. The post-session insights call is capped at 1400
 * output tokens; when the reply is cut off there the JSON does not parse, the
 * error is logged, and nothing is stored: no summary, no draft SOAP note, no
 * safety line, no case profile update, and no retry
 * (sessionInsights.service.ts). Seen live on 2026-11-18 in 2 of 123 sessions,
 * one of them a session that ended at a high crisis flag. Remove this marker
 * when the bug is fixed and the assertion gates again.
 */
export const SUMMARY_LOSS_GAP: KnownGap = {
  reason:
    'The post-session insights reply can be cut off at max_tokens (1400); the truncated JSON is thrown away and the ' +
    'session is left with no summary, SOAP note or safety line, with no retry.',
  ref: 'ai-therapist-346',
};

export const summaryStoredId = (session: string): string => `post-session-summary-stored@${session}`;

/**
 * The runner's own assertion, one per session: the post-session job stored a
 * summary. Failing, it is reported under SUMMARY_LOSS_GAP and does not gate.
 */
export function summaryStoredResult(record: SessionRecord, gap: KnownGap | null = SUMMARY_LOSS_GAP): AssertionResult {
  const id = summaryStoredId(record.id);
  // A stored summary is the ordinary case and is reported plainly: the marker
  // is attached only to a failure, so a run does not list every session as a
  // known gap that happened to pass.
  if (record.summary) {
    const headline = String(record.summary.headline ?? '').slice(0, 80);
    return { id, passed: true, gating: true, detail: `summary stored ("${headline}")` };
  }
  const failed: AssertionResult = {
    id,
    passed: false,
    gating: true,
    detail: `no summary in session_insights for ${record.sessionId}: the post-session job failed or never ran`,
  };
  return gap ? applyKnownGap({ knownGap: { ...gap, assertionIds: [id] } }, [failed])[0] : failed;
}

/** Reported when a scenario stops early because a later session's premise is gone. */
export function cutShortResult(after: string, notRun: string[]): AssertionResult {
  return {
    id: 'scenario-cut-short',
    passed: false,
    gating: false,
    detail:
      `stopped after '${after}': it has no stored summary, so the next session would be built without it and its ` +
      `checks would test nothing. Not run: ${notRun.length ? notRun.join(', ') : 'final assertions only'}`,
  };
}

export interface MultiSessionDeps {
  runAssertions: (specs: AssertionSpec[] | undefined, ctx: AssertionContext) => Promise<AssertionResult[]>;
  /** Register a session's transcript with the runner's cost pass. */
  noteTranscript: (sessionId: string, transcript: Turn[]) => void;
  canaries: string[];
}

const DRY_RUN_REPLY = '[dry-run assistant] Thank you for telling me. What feels most important about that right now?';

/** Drive a scenario's sessions in order. Mirrors cli.ts runChatScenario for
 *  each one; see the header for what happens between them. */
export async function runMultiSessionScenario(
  scenario: Scenario,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  cost: CostTracker,
  pool: DbLike,
  classify: AssertionContext['classify'],
  deps: MultiSessionDeps,
): Promise<{
  assertions: AssertionResult[];
  judge: null;
  judgeBreaches: boolean;
  sessionId: string;
  transcript: Turn[];
}> {
  const problems = validateMultiSession(scenario);
  if (problems.length) throw new Error(`invalid multi-session scenario: ${problems.join('; ')}`);
  if (scenario.setup) await scenario.setup(pool);

  const specs = scenario.sessions ?? [];
  const participantSpecs = scenario.participants ?? {};
  const firstKey = Object.keys(participantSpecs)[0];
  const participants: Record<string, CreatedParticipant> = {};
  const agents: Record<string, Agent> = {};
  for (const [key, spec] of Object.entries(participantSpecs)) {
    participants[key] = await createParticipant(pool, scenario.id, key, spec);
    const agent = client.newAgent();
    await client.loginParticipant(agent, { username: participants[key].username, password: MULTI_SESSION_PASSWORD });
    await client.acceptConsent(agent);
    agents[key] = agent;
  }

  const records: SessionRecord[] = [];
  const assertions: AssertionResult[] = [];
  const combined: Turn[] = [];
  let cutShort = false;

  const ctxFor = (record: SessionRecord, latestReply: string, beatId?: string): AssertionContext => ({
    scenarioId: scenario.id,
    sessionId: record.sessionId,
    beatId,
    latestReply,
    transcript: record.transcript,
    emissions: client.emissions,
    beatPostTimes: {},
    systemPromptCanaries: deps.canaries,
    sessions: records,
    pool,
    classify,
    dryRun: cfg.dryRun,
  });

  for (const spec of specs) {
    const key = spec.participant ?? firstKey;
    const who = participants[key];
    const agent = agents[key];
    const pending: Record<string, unknown> = {};
    let record: SessionRecord | null = null;
    const env: SessionHookEnv = {
      pool,
      dryRun: cfg.dryRun,
      participants,
      userId: who.userId,
      sessions: records,
      request: async (method, path, body) => {
        const req = method === 'GET' ? agent.get(path) : method === 'PUT' ? agent.put(path) : agent.post(path);
        const res = body === undefined ? await req : await req.send(body as object);
        return { status: res.status, body: res.body as unknown };
      },
      observe: (k, v) => {
        (record ? record.observations : pending)[k] = v;
      },
    };

    if (spec.daysSincePrevious) await ageParticipantHistory(pool, who.userId, spec.daysSincePrevious);
    await spec.before?.(env);

    const { sessionId, opening } = await client.startFreshChat(agent, { checkin: spec.checkin });
    // Harness sessions are not study data. /api/chat/start marks only the
    // shared harness account is_demo (utils/harness.ts), so mark these here:
    // every analytics and export surface, and the adverse-event auto-draft,
    // skips is_demo sessions.
    await pool.query(`UPDATE therapy_sessions SET is_demo = TRUE WHERE session_id = $1`, [sessionId]);

    const transcript: Turn[] = [];
    deps.noteTranscript(sessionId, transcript);
    if (opening) transcript.push({ role: 'assistant', text: opening, beatId: 'opening', session: spec.id });
    record = {
      id: spec.id,
      sessionId,
      participant: key,
      userId: who.userId,
      username: who.username,
      opening,
      systemPrompt: await readSystemPrompt(pool, sessionId),
      transcript,
      summary: null,
      observations: pending,
    };
    records.push(record);
    env.sessionId = sessionId;
    const current = record;

    await client.driveChatSession(agent, sessionId, async () => {
      for (const beat of spec.beats) {
        const utter = await generatePersonaTurn(openai as OpenAI, cost, cfg, scenario, beat, transcript);
        transcript.push({ role: 'user', text: utter, beatId: beat.id, session: spec.id });
        const reply = cfg.dryRun ? DRY_RUN_REPLY : (await client.chatMessage(agent, sessionId, utter)).response;
        transcript.push({ role: 'assistant', text: reply, beatId: beat.id, session: spec.id });
        assertions.push(...(await deps.runAssertions(beat.assertAfter, ctxFor(current, reply, beat.id))));
      }
      await spec.beforeEnd?.(env);
    });

    if (!cfg.dryRun) {
      current.summary = await waitForSummary(pool, sessionId, {
        expectCaseProfileFor: participantSpecs[key].memoryEnabled ? who.userId : null,
      });
      assertions.push(summaryStoredResult(current));
    }
    combined.push(...transcript);
    assertions.push(
      ...(await deps.runAssertions(spec.assertAfter, ctxFor(current, transcript.at(-1)?.text ?? '', undefined))),
    );
    // A memory-on participant's next session is built from this summary. If
    // the product lost it, every later check in the scenario would be testing
    // a different situation from the one it describes: stop, and say so.
    if (!cfg.dryRun && !current.summary && participantSpecs[key].memoryEnabled) {
      const notRun = specs.slice(specs.indexOf(spec) + 1).map((s) => s.id);
      console.warn(
        `[redteam] ${scenario.id}: no summary stored for '${spec.id}' (${sessionId}); stopping the scenario`,
      );
      assertions.push(cutShortResult(spec.id, notRun));
      cutShort = true;
      break;
    }
  }

  const last = records.at(-1);
  if (!last) throw new Error(`${scenario.id}: no session ran`);
  // Under a named variant, prove every session ran with it (as runChatScenario does).
  for (const r of records) {
    const applied = await checkVariantApplied(getVariant(cfg.variant), pool, r.sessionId);
    if (applied)
      assertions.push({
        id: 'variant-applied',
        passed: applied.passed,
        detail: `${r.id}: ${applied.detail}`,
        gating: true,
      });
  }
  if (!cutShort)
    assertions.push(
      ...(await deps.runAssertions(scenario.assertFinal, ctxFor(last, last.transcript.at(-1)?.text ?? ''))),
    );
  return { assertions, judge: null, judgeBreaches: false, sessionId: last.sessionId, transcript: combined };
}
