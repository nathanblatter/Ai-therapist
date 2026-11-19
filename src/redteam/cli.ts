// Red-team harness entrypoint (spec §8). Boots the real server in-process,
// drives scripted personas through the chat + realtime-text pipelines, runs
// hard assertions + the v1 judge, writes JUnit/summary, and sets the exit code.
//
//   npx tsx src/redteam/cli.ts --suite smoke
//
// Flags: --suite smoke|full|quality|voice|voice-safety|extended|voice-crawl|voice-walk|voice-run
//        --scenario <id>  --out <dir>
//        --judge-model <m>  --seed <n>  --variations <k>  --allow-fail  --dry-run
//        --baseline <path|latest>  --gate-diff  --gate-quality
//        --variant <name> (run under a named feature-flag variant: default,
//          lead-conversation, psychoeducation-cue; see variants.ts)
//        --voice-text-turns (voice suite: typed-text turns instead of TTS audio)
//        --voice-drop-client-midway / --voice-drop-upstream-midway (Grok voice:
//          sever the browser socket / the xAI socket after the first beat and
//          verify the session continues — docs/grok-voice.md section 3)
//        --generated-variants <n>  --generated-operators <a,b>  --variant-cache <dir>
//        --gate-generated (opt-in LLM-generated mutations of the safety
//          scenarios, ai-therapist-109; off by default, never in CI)
import 'dotenv/config';

// ---- env guards (MUST run before importing server modules) ----------------
// Never page a real on-call from CI (spec R3b). Setting to '' (not delete) so a
// later dotenv.config() in a server module can't re-populate it from .env.
process.env.IMESSAGE_API_KEY = '';
process.env.CRISIS_ALERT_PHONE = '';
// Don't fan this process's socket emissions out to real admin dashboards when
// sharing a DB with a live deployment (admin-triggered runs).
process.env.SOCKET_PG_ADAPTER = 'off';
// ALWAYS test env, even when spawned inside the production container: under
// NODE_ENV=production the session cookie is secure-only, so the in-process
// supertest agent (plain HTTP) never receives it and participant login times
// out ("login did not persist to the session store"). CI runs this way too.
process.env.NODE_ENV = 'test';
// The admin assistant is dark (503) unless this is set; the harness must be
// able to red-team it wherever it runs (ai-therapist-207). In-process only —
// it never flips the flag for a deployment sharing the DB.
process.env.ASSISTANT_ENABLED = 'true';

import type OpenAI from 'openai';
import {
  DEFAULTS,
  CHAT_THERAPY_MODEL,
  CostTracker,
  isRedteamSuite,
  type CostCategory,
  type RedteamConfig,
} from './config.js';
import {
  costNotes,
  settleSessionCosts,
  type RunCostNotes,
  type SessionCostPlan,
  type SettledCost,
} from './sessionCost.js';
import { makeClassifier } from './assertions.js';
import { generatePersonaTurn, applyVariation } from './personaDriver.js';
import { runJudge } from './judge.js';
import { participantIdentityProblem } from './participantIdentity.js';
import { runProgressionJudge, SESSION_PROGRESSION, type ProgressionJudgeResult } from './progressionJudge.js';
import { computeProgression } from './progression.js';
import {
  applyVariant,
  checkVariantApplied,
  getVariant,
  persistedSuiteLabel,
  variantLabel,
  DEFAULT_VARIANT,
} from './variants.js';
import { HarnessClient, type Agent } from './harnessClient.js';
import type { RunMetrics } from './voice/metrics.js';
import { writeReports, printConsole, buildSummaryJson, type RunSummary } from './report.js';
import {
  diffRuns,
  formatDiffConsole,
  formatDiffMarkdown,
  normalizeHarnessRun,
  normalizeSummary,
  type NormalizedRun,
  type RunDiff,
} from './diff.js';
import { selectSuite, SAFETY_SCENARIOS, type SuiteEntry } from './scenarios/index.js';
import { applyKnownGap, reportKnownGaps } from './knownGap.js';
import {
  buildGeneratedVariants,
  clampVariantCount,
  isOperatorId,
  MAX_GENERATED_VARIANTS,
  OPERATOR_IDS,
  type DiscardedVariant,
  type GeneratorClient,
} from './generatedVariants.js';
import type {
  AssertionContext,
  AssertionResult,
  AssertionSpec,
  AssistantRole,
  Beat,
  GeneratedVariantMeta,
  Scenario,
  ScenarioResult,
  Turn,
} from './types.js';

/** The chat model this run exercises: system_config.chat_model in the scratch
 *  database, resolved by the same helper /api/chat/start uses, so the harness
 *  always tests (and prices) what chat actually runs. Set a candidate with
 *  `UPDATE system_config ... chat_model` before the run; never via code. */
async function chatModelUnderTest(): Promise<string> {
  const { resolveChatModel } = await import('../server/utils/chatModel.js');
  return resolveChatModel().catch(() => CHAT_THERAPY_MODEL);
}

const SAFE_ASSISTANT_STUB =
  "I hear you, and I'm really glad you told me. That sounds incredibly heavy to carry. " +
  "You are not alone in this. If you're in crisis, please reach the 988 Suicide & Crisis Lifeline (call or text 988). " +
  "I'm here with you — can you tell me a little more about how you're feeling right now?";

function parseArgs(argv: string[]): RedteamConfig {
  const cfg: RedteamConfig = {
    personaModel: DEFAULTS.personaModel,
    classifierModel: DEFAULTS.classifierModel,
    judgeModel: DEFAULTS.judgeModel,
    seed: DEFAULTS.seed,
    outDir: DEFAULTS.outDir,
    suite: DEFAULTS.suite,
    variations: DEFAULTS.variations,
    allowFail: DEFAULTS.allowFail,
    dryRun: DEFAULTS.dryRun,
    gateDiff: DEFAULTS.gateDiff,
    gateQuality: DEFAULTS.gateQuality,
    voiceTextTurns: DEFAULTS.voiceTextTurns,
    voiceDropClientMidway: DEFAULTS.voiceDropClientMidway,
    voiceDropUpstreamMidway: DEFAULTS.voiceDropUpstreamMidway,
    variant: DEFAULTS.variant,
    generatedVariants: DEFAULTS.generatedVariants,
    variantCacheDir: DEFAULTS.variantCacheDir,
    gateGenerated: DEFAULTS.gateGenerated,
    generatorModel: DEFAULTS.generatorModel,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--suite': {
        const v = next();
        cfg.suite = isRedteamSuite(v) ? v : 'full';
        break;
      }
      case '--scenario':
        cfg.scenarioId = next();
        break;
      case '--out':
        cfg.outDir = next();
        break;
      case '--judge-model':
        cfg.judgeModel = next();
        cfg.judgeModelOverride = cfg.judgeModel;
        break;
      case '--seed':
        cfg.seed = Number(next());
        break;
      case '--variations':
        cfg.variations = Math.max(1, Number(next()) || 1);
        break;
      case '--allow-fail':
        cfg.allowFail = true;
        break;
      case '--dry-run':
        cfg.dryRun = true;
        break;
      case '--baseline':
        cfg.baseline = next();
        break;
      case '--gate-diff':
        cfg.gateDiff = true;
        break;
      case '--gate-quality':
        cfg.gateQuality = true;
        break;
      case '--voice-text-turns':
        cfg.voiceTextTurns = true;
        break;
      case '--voice-drop-client-midway':
        cfg.voiceDropClientMidway = true;
        break;
      case '--voice-drop-upstream-midway':
        cfg.voiceDropUpstreamMidway = true;
        break;
      case '--variant':
        cfg.variant = next();
        break;
      case '--generated-variants': {
        const requested = Number(next());
        cfg.generatedVariants = clampVariantCount(requested);
        if (requested > MAX_GENERATED_VARIANTS)
          console.warn(`[redteam] --generated-variants capped at ${MAX_GENERATED_VARIANTS} (asked for ${requested})`);
        break;
      }
      case '--generated-operators': {
        const ops = (next() ?? '')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
        const unknown = ops.filter((o) => !isOperatorId(o));
        if (unknown.length)
          throw new Error(`unknown mutation operator(s): ${unknown.join(', ')} (known: ${OPERATOR_IDS.join(', ')})`);
        cfg.generatedOperators = ops;
        break;
      }
      case '--variant-cache':
        cfg.variantCacheDir = next();
        break;
      case '--gate-generated':
        cfg.gateGenerated = true;
        break;
      default:
        break;
    }
  }
  return cfg;
}

async function makeOpenAI(cfg: RedteamConfig): Promise<OpenAI | null> {
  if (cfg.dryRun) return null;
  const OpenAI = (await import('openai')).default;
  const { getOpenAIKey } = await import('../server/config/secrets.js');
  return new OpenAI({ apiKey: await getOpenAIKey() });
}

/** Extract markdown headings from the live chat system prompt as leak canaries. */
async function loadCanaries(): Promise<string[]> {
  const { getSystemPrompt } = await import('../server/utils/sessionHelpers.js');
  const prompt = await getSystemPrompt('en', 'chat');
  const headings = prompt
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.trim());
  // De-dup and keep only reasonably distinctive headings.
  return Array.from(new Set(headings)).filter((h) => h.length >= 6);
}

/** Length of the tool definitions every chat call carries (chatTherapy
 *  sends the enabled chat tools), for estimated replies. 0 if unreadable. */
async function chatToolChars(): Promise<number> {
  try {
    const { toolRegistry } = await import('../server/services/toolRegistry.service.js');
    return JSON.stringify(await toolRegistry.getEnabledToolDefinitions({ channel: 'chat' })).length;
  } catch {
    return 0;
  }
}

/** Length of the base chat system prompt: the cost pass's fallback when a
 *  session has no stored assembled prompt. */
async function baseChatPromptChars(): Promise<number> {
  const { getSystemPrompt } = await import('../server/utils/sessionHelpers.js');
  return (await getSystemPrompt('en', 'chat').catch(() => '')).length;
}

function buildCtx(
  scenario: Scenario,
  sessionId: string,
  latestReply: string,
  transcript: Turn[],
  client: HarnessClient,
  beatPostTimes: Record<string, Date>,
  canaries: string[],
  pool: AssertionContext['pool'],
  classify: AssertionContext['classify'],
  cfg: RedteamConfig,
  beatId?: string,
  extra?: Partial<
    Pick<AssertionContext, 'chatSessionEnded' | 'lastMessageStatus' | 'lastMessageBody' | 'assistant' | 'http'>
  >,
): AssertionContext {
  return {
    scenarioId: scenario.id,
    sessionId,
    beatId,
    latestReply,
    transcript,
    emissions: client.emissions,
    beatPostTimes,
    systemPromptCanaries: canaries,
    pool,
    classify,
    dryRun: cfg.dryRun,
    ...extra,
  };
}

async function runAssertions(specs: AssertionSpec[] | undefined, ctx: AssertionContext): Promise<AssertionResult[]> {
  if (!specs) return [];
  const out: AssertionResult[] = [];
  for (const spec of specs) {
    try {
      const r = await spec.run(ctx);
      out.push({ ...r, gating: spec.gating === false ? false : r.gating });
    } catch (err) {
      out.push({
        id: spec.id,
        passed: false,
        detail: `assertion threw: ${(err as Error).message}`,
        gating: spec.gating !== false,
      });
    }
  }
  return out;
}

async function runChatScenario(
  scenario: Scenario,
  beats: Beat[],
  runJudgeFlag: boolean,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  cost: CostTracker,
  canaries: string[],
  pool: AssertionContext['pool'],
  classify: AssertionContext['classify'],
): Promise<{
  assertions: AssertionResult[];
  judge: ScenarioResult['judge'];
  judgeBreaches: boolean;
  sessionId: string;
  transcript?: Turn[];
}> {
  if (scenario.setup) await scenario.setup(pool);
  const agent: Agent = client.newAgent();
  await client.loginParticipant(agent, scenario.participant);
  await client.acceptConsent(agent);
  // Always a brand-new session, and always ended, even when a turn throws
  // (ai-therapist-307): every chat scenario is the same participant, so a
  // session left open would carry its risk history into the next scenario.
  const { sessionId, opening } = await client.startFreshChat(agent);
  const transcript: Turn[] = [];
  sessionTranscripts.set(sessionId, transcript);
  // The server-authored opening is the first assistant turn the participant
  // reads, so it heads the transcript; disclaimer-exactly-once-at-start
  // asserts on it rather than on whatever the model improvises.
  if (opening) transcript.push({ role: 'assistant', text: opening, beatId: 'opening' });
  const assertions: AssertionResult[] = [];

  await client.driveChatSession(agent, sessionId, async () => {
    for (const beat of beats) {
      const utter = await generatePersonaTurn(openai as OpenAI, cost, cfg, scenario, beat, transcript);
      transcript.push({ role: 'user', text: utter, beatId: beat.id });

      let reply = '';
      let sessionEnded = false;
      let extra: Partial<Pick<AssertionContext, 'chatSessionEnded' | 'lastMessageStatus' | 'lastMessageBody'>> = {};

      if (beat.expectInactive) {
        // Expect the session to already be ended (e.g. by the eligibility gate).
        if (cfg.dryRun) {
          extra = { lastMessageStatus: 400, lastMessageBody: { error: 'Session is not active' } };
        } else {
          const raw = await client.chatMessageRaw(agent, sessionId, utter);
          extra = { lastMessageStatus: raw.status, lastMessageBody: raw.body };
        }
        // No assistant turn is recorded — the message was rejected.
      } else if (cfg.dryRun) {
        reply = `[dry-run assistant] I'm an AI, not a licensed therapist, and I can't diagnose. I can listen and share coping ideas.`;
        transcript.push({ role: 'assistant', text: reply, beatId: beat.id });
      } else {
        const res = await client.chatMessage(agent, sessionId, utter);
        reply = res.response;
        sessionEnded = res.sessionEnded;
        extra = { chatSessionEnded: sessionEnded };
        // Priced after the run from the app's own usage rows (sessionCost.ts).
        transcript.push({ role: 'assistant', text: reply, beatId: beat.id });
      }

      const ctx = buildCtx(
        scenario,
        sessionId,
        reply,
        transcript,
        client,
        {},
        canaries,
        pool,
        classify,
        cfg,
        beat.id,
        extra,
      );
      assertions.push(...(await runAssertions(beat.assertAfter, ctx)));
    }
  });

  const finalCtx = buildCtx(
    scenario,
    sessionId,
    transcript.at(-1)?.text ?? '',
    transcript,
    client,
    {},
    canaries,
    pool,
    classify,
    cfg,
  );
  assertions.push(...(await runAssertions(scenario.assertFinal, finalCtx)));

  // Under a named variant, prove the session actually ran with it (assembled
  // prompt + recorded arm in session_configurations); otherwise the variant's
  // results would silently be default results with a different label.
  const applied = await checkVariantApplied(getVariant(cfg.variant), pool, sessionId);
  if (applied) assertions.push({ id: 'variant-applied', passed: applied.passed, detail: applied.detail, gating: true });

  let judge: ScenarioResult['judge'] = null;
  let judgeBreaches = false;
  if (runJudgeFlag) {
    const outcome = await runJudge(sessionId, scenario, cfg, cost);
    if (outcome) {
      judge = outcome.scores;
      assertions.push(...outcome.floorAssertions);
      judgeBreaches = outcome.floorAssertions.some((a) => !a.passed && a.gating);
    }
    // Report-only session_progression (progressionJudge.ts): never a floor.
    judge = withProgression(judge, await runProgressionJudge(sessionId, cfg, cost));
  }
  return { assertions, judge, judgeBreaches, sessionId, transcript };
}

/** Fold the session_progression score into the scenario's judge result. */
function withProgression(judge: ScenarioResult['judge'], prog: ProgressionJudgeResult | null): ScenarioResult['judge'] {
  if (!prog) return judge;
  const base = judge ?? { scores: {}, overall: null };
  const perJudge = { ...(base.perJudge ?? {}) };
  for (const [key, score] of Object.entries(prog.perJudge)) {
    perJudge[key] = { ...(perJudge[key] ?? {}), [SESSION_PROGRESSION]: score };
  }
  return {
    ...base,
    scores: { ...base.scores, [SESSION_PROGRESSION]: prog.score },
    perJudge,
    spread:
      base.spread || prog.spread !== null
        ? { ...(base.spread ?? {}), [SESSION_PROGRESSION]: prog.spread ?? 0 }
        : base.spread,
    progressionRationale: prog.rationale,
  };
}

async function runRealtimeScenario(
  scenario: Scenario,
  beats: Beat[],
  runJudgeFlag: boolean,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  cost: CostTracker,
  canaries: string[],
  pool: AssertionContext['pool'],
  classify: AssertionContext['classify'],
): Promise<{
  assertions: AssertionResult[];
  judge: ScenarioResult['judge'];
  judgeBreaches: boolean;
  sessionId: string;
  transcript?: Turn[];
}> {
  const agent: Agent = client.newAgent();
  await client.acceptConsent(agent);
  const sessionId = `redteam_rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  client.noteSession(sessionId);
  const transcript: Turn[] = [];
  sessionTranscripts.set(sessionId, transcript);
  const assertions: AssertionResult[] = [];
  const beatPostTimes: Record<string, Date> = {};
  const { updateSessionStatus } = await import('../server/db/index.js');

  // End the session even when a beat throws, so nothing is left active.
  try {
    for (const beat of beats) {
      const utter =
        beat.verbatim ?? (await generatePersonaTurn(openai as OpenAI, cost, cfg, scenario, beat, transcript));
      beatPostTimes[beat.id] = new Date();
      await client.postParticipantTurn(agent, sessionId, utter);
      await client.postAssistantStub(agent, sessionId, SAFE_ASSISTANT_STUB);
      transcript.push({ role: 'user', text: utter, beatId: beat.id });
      transcript.push({ role: 'assistant', text: SAFE_ASSISTANT_STUB, beatId: beat.id });

      const ctx = buildCtx(
        scenario,
        sessionId,
        '',
        transcript,
        client,
        beatPostTimes,
        canaries,
        pool,
        classify,
        cfg,
        beat.id,
      );
      assertions.push(...(await runAssertions(beat.assertAfter, ctx)));
    }
  } catch (err) {
    // The session row exists only once a batch landed; best-effort either way.
    await updateSessionStatus(sessionId, 'ended', 'user').catch(() => undefined);
    throw err;
  }

  // End the realtime session so the judge (which requires status='ended') runs.
  await updateSessionStatus(sessionId, 'ended', 'user');

  const finalCtx = buildCtx(scenario, sessionId, '', transcript, client, beatPostTimes, canaries, pool, classify, cfg);
  assertions.push(...(await runAssertions(scenario.assertFinal, finalCtx)));

  let judge: ScenarioResult['judge'] = null;
  let judgeBreaches = false;
  if (runJudgeFlag) {
    const outcome = await runJudge(sessionId, scenario, cfg, cost);
    if (outcome) {
      judge = outcome.scores;
      assertions.push(...outcome.floorAssertions);
      judgeBreaches = outcome.floorAssertions.some((a) => !a.passed && a.gating);
    }
  }
  return { assertions, judge, judgeBreaches, sessionId, transcript };
}

/** The staff account each assistant role logs in as (seeded by
 *  ensureAssistantFixtures). Exposed for the runner's per-role sessions. */
interface StaffSession {
  agent: Agent;
  userId: number;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Assistant pipeline (ai-therapist-207): the persona is a STAFF member asking
 * the admin data assistant questions. Each beat runs as `beat.assistantRole ??
 * scenario.assistantRole` with that role's own login + conversation history,
 * so one scenario can probe several roles. Beats are verbatim staff questions
 * by design (the adversarial content is in the seeded DATA, not the persona),
 * but a beat without `verbatim` still goes through the persona LLM. No therapy
 * session is created and the judge never runs: the assertions carry it.
 */
async function runAssistantScenario(
  scenario: Scenario,
  beats: Beat[],
  _runJudgeFlag: boolean,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  cost: CostTracker,
  _canaries: string[],
  pool: AssertionContext['pool'],
  classify: AssertionContext['classify'],
): Promise<{
  assertions: AssertionResult[];
  judge: ScenarioResult['judge'];
  judgeBreaches: boolean;
  sessionId: string;
  transcript?: Turn[];
}> {
  const { ensureAssistantFixtures, ASSISTANT_STAFF, ASSISTANT_STAFF_PASSWORD } = await import('./assistantFixtures.js');
  const { assistantPromptCanaries } = await import('./assistantAssertions.js');
  const { ASSISTANT_MODEL } = await import('../server/services/assistant.service.js');

  const startedAt = new Date();
  await ensureAssistantFixtures(pool);
  const canaries = assistantPromptCanaries();
  const defaultRole: AssistantRole = scenario.assistantRole ?? 'researcher';
  const sessions = new Map<AssistantRole, StaffSession>();
  const callers: Array<{ role: AssistantRole; userId: number }> = [];
  const transcript: Turn[] = [];
  const assertions: AssertionResult[] = [];

  const sessionFor = async (role: AssistantRole): Promise<StaffSession> => {
    const existing = sessions.get(role);
    if (existing) return existing;
    const agent = client.newAgent();
    const userId = await client.loginStaff(agent, ASSISTANT_STAFF[role], ASSISTANT_STAFF_PASSWORD);
    const s: StaffSession = { agent, userId, history: [] };
    sessions.set(role, s);
    callers.push({ role, userId });
    return s;
  };

  let last: AssertionContext['assistant'] | undefined;
  for (const beat of beats) {
    const role = beat.assistantRole ?? defaultRole;
    const s = await sessionFor(role);
    const utter = beat.verbatim ?? (await generatePersonaTurn(openai as OpenAI, cost, cfg, scenario, beat, transcript));
    s.history.push({ role: 'user', content: utter });
    transcript.push({ role: 'user', text: `[${role}] ${utter}`, beatId: beat.id });

    let answer: string;
    let toolCalls: Array<{ name: string; rowCount: number }> = [];
    if (cfg.dryRun) {
      answer =
        '[dry-run assistant] I only work with aggregates, scores and statuses from my tools and cannot share transcripts; use the corresponding admin panel.';
    } else {
      const res = await client.assistantTurn(s.agent, s.history);
      answer = res.answer;
      toolCalls = res.toolCalls;
      // Real token usage lands on the audit row the turn just wrote.
      const { rows } = await pool.query(
        `SELECT input_tokens, output_tokens FROM assistant_audit
         WHERE user_id = $1 AND created_at >= $2 ORDER BY audit_id DESC LIMIT 1`,
        [s.userId, startedAt],
      );
      const u = rows[0];
      if (u) cost.addRecorded(ASSISTANT_MODEL, Number(u.input_tokens ?? 0), Number(u.output_tokens ?? 0), 'assistant');
      else cost.estimate(ASSISTANT_MODEL, 2500, 300, 'assistant');
    }
    s.history.push({ role: 'assistant', content: answer });
    transcript.push({ role: 'assistant', text: answer, beatId: beat.id });
    console.log(
      `[redteam:assistant] ${beat.id} (${role}): tools [${toolCalls.map((t) => `${t.name}:${t.rowCount}`).join(', ')}]`,
    );

    last = { role, userId: s.userId, question: utter, toolCalls, callers, startedAt };
    const ctx = buildCtx(scenario, '', answer, transcript, client, {}, canaries, pool, classify, cfg, beat.id, {
      assistant: last,
    });
    assertions.push(...(await runAssertions(beat.assertAfter, ctx)));
  }

  const finalCtx = buildCtx(
    scenario,
    '',
    transcript.at(-1)?.text ?? '',
    transcript,
    client,
    {},
    canaries,
    pool,
    classify,
    cfg,
    undefined,
    { assistant: last },
  );
  assertions.push(...(await runAssertions(scenario.assertFinal, finalCtx)));

  return { assertions, judge: null, judgeBreaches: false, sessionId: '', transcript };
}

/**
 * HTTP pipeline (docs/eval-scenario-catalogue.md A2 gates, STAFF-10): no
 * persona, no model, no judge. The scenario's probe drives the real routes on
 * accounts and rows it seeded itself, and its final assertions read what the
 * probe recorded. Identical with and without --dry-run: nothing here can call
 * a model, so there is nothing to stub.
 */
async function runHttpScenario(
  scenario: Scenario,
  _beats: Beat[],
  _runJudgeFlag: boolean,
  client: HarnessClient,
  _openai: OpenAI | null,
  cfg: RedteamConfig,
  _cost: CostTracker,
  canaries: string[],
  pool: AssertionContext['pool'],
  classify: AssertionContext['classify'],
): Promise<{
  assertions: AssertionResult[];
  judge: null;
  judgeBreaches: false;
  sessionId: string;
  transcript?: Turn[];
}> {
  if (!scenario.httpProbe) throw new Error(`${scenario.id}: http pipeline scenario has no httpProbe`);
  if (scenario.setup) await scenario.setup(pool);
  const http = await scenario.httpProbe({ client, pool, dryRun: cfg.dryRun });
  const ctx = buildCtx(scenario, '', '', [], client, {}, canaries, pool, classify, cfg, undefined, { http });
  const assertions = await runAssertions(scenario.assertFinal, ctx);
  return { assertions, judge: null, judgeBreaches: false, sessionId: '' };
}

async function runEntry(
  entry: SuiteEntry,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  canaries: string[],
  pool: AssertionContext['pool'],
  variation = 0,
  generated?: { meta: GeneratedVariantMeta; generationCostUsd: number },
): Promise<ScenarioResult> {
  // Variation v>0: styled persona + shifted seed; ids get a #v2/#v3 suffix so
  // reports and the DB keep each variation as its own row.
  const scenario = applyVariation(entry.scenario, variation);
  const vcfg: RedteamConfig = variation > 0 ? { ...cfg, seed: cfg.seed + variation } : cfg;
  const label = variation > 0 ? `${scenario.id}#v${variation + 1}` : scenario.id;
  const beats = entry.beatIds ? scenario.beats.filter((b) => entry.beatIds!.includes(b.id)) : scenario.beats;
  const runJudgeFlag = entry.judge ?? scenario.runJudge;
  const cost = new CostTracker();
  // A freshly generated variant carries its generation + guard spend.
  if (generated?.generationCostUsd) cost.addUsd(generated.generationCostUsd, 'generation', 'recorded');
  const classify = makeClassifier(openai, vcfg, cost);
  const start = Date.now();
  const sessionsBefore = client.sessionsStarted.length;
  // Book the app-side spend of every session this scenario created, errored
  // or not, once the run is over (settleRunCosts).
  const ledger = (result: ScenarioResult): ScenarioResult => {
    const ids = client.sessionsStarted.slice(sessionsBefore);
    costLedger.push({ result, cost, sessionIds: ids, pipeline: scenario.pipeline });
    result.cost = cost.breakdown();
    return result;
  };

  try {
    if (scenario.requiresReservedParticipant && !cfg.dryRun) {
      const problem = await participantIdentityProblem(pool);
      if (problem) throw new Error(problem);
    }
    // Voice needs a live OpenAI client (persona TTS) and a real voice backend;
    // in dry-run it falls back to the realtime-text flow so the offline
    // pipeline completes.
    const runner =
      scenario.pipeline === 'chat'
        ? runChatScenario
        : scenario.pipeline === 'assistant'
          ? runAssistantScenario
          : scenario.pipeline === 'http'
            ? runHttpScenario
            : scenario.pipeline === 'voice' && !cfg.dryRun
              ? (await import('./voiceClient.js')).runVoiceScenario
              : runRealtimeScenario;
    // Scenario fixture (test-only fault injection): installed around the run
    // and always undone, so a failed scenario cannot leak its fault into the next.
    const undoFixture = await scenario.fixture?.({ pool, dryRun: cfg.dryRun });
    const res = await runner(
      scenario,
      beats,
      runJudgeFlag,
      client,
      openai,
      vcfg,
      cost,
      canaries,
      pool,
      classify,
    ).finally(async () => {
      // Backstop for ai-therapist-307: no chat session outlives its scenario,
      // whichever runner started it and however it ended.
      const leftover = await client.endOpenChats();
      if (leftover.length) console.error(`[redteam] ${label}: ended leftover chat session(s) ${leftover.join(', ')}`);
      await undoFixture?.();
      await scenario.teardown?.(pool);
    });
    const { judge, judgeBreaches, sessionId, transcript } = res;
    const assertions = applyKnownGap(scenario, res.assertions);
    const voiceMetrics = (res as { voiceMetrics?: RunMetrics }).voiceMetrics;
    const gatingFail = assertions.some((a) => !a.passed && a.gating) || judgeBreaches;
    return ledger({
      id: label,
      title: scenario.title,
      pipeline: scenario.pipeline,
      variation,
      passed: !gatingFail,
      assertions,
      judge,
      // The assistant pipeline drives no therapy session.
      sessionId: sessionId || undefined,
      transcript,
      progression: computeProgression(scenario.pipeline, transcript),
      costUsd: cost.usd,
      durationMs: Date.now() - start,
      generated: generated?.meta,
      ...(voiceMetrics ? { voiceMetrics } : {}),
    });
  } catch (err) {
    return ledger({
      id: label,
      title: scenario.title,
      pipeline: scenario.pipeline,
      variation,
      passed: false,
      assertions: [],
      judge: null,
      costUsd: cost.usd,
      durationMs: Date.now() - start,
      error: (err as Error).message,
      generated: generated?.meta,
    });
  }
}

/** Per-scenario spend awaiting the app-side usage pass (settleRunCosts). */
const costLedger: Array<{ result: ScenarioResult; cost: CostTracker; sessionIds: string[]; pipeline: string }> = [];
/** Transcripts by session id, kept even when a scenario throws, so an errored
 *  scenario's estimated replies can still be priced. */
const sessionTranscripts = new Map<string, Turn[]>();

/**
 * Book what the app spent on this run's sessions (chat replies, crisis
 * assessor, redaction, insights) from session_llm_usage into each scenario,
 * then refresh every result's cost. Waits (bounded) for the post-session jobs
 * /api/chat/end starts. Skipped under --dry-run, which makes no model calls.
 */
async function settleRunCosts(
  cfg: RedteamConfig,
  pool: AssertionContext['pool'],
  defaultPromptChars: number,
): Promise<RunCostNotes> {
  let settled: SettledCost | null = null;
  if (!cfg.dryRun) {
    const chatModel = await chatModelUnderTest();
    const plans: SessionCostPlan[] = costLedger.flatMap((e) =>
      // The voice runners price voice minutes and delegation tokens
      // themselves (sessionCost.ts skips those purposes). They do not register
      // their sessions with client.noteSession yet, so a voice scenario has no
      // ids here; once they do, its crisis assessor and post-session jobs are
      // counted by this same pass.
      e.pipeline === 'chat' || e.pipeline === 'realtime-text' || e.pipeline === 'voice'
        ? e.sessionIds.map((sessionId) => ({
            scenarioId: e.result.id,
            sessionId,
            pipeline: e.result.pipeline,
            transcript: sessionTranscripts.get(sessionId) ?? e.result.transcript ?? [],
            chatModel,
            expectPostSession: e.pipeline !== 'realtime-text',
            cost: e.cost,
          }))
        : [],
    );
    if (plans.length) {
      console.log(`[redteam] cost: reading app usage for ${plans.length} session(s), waiting for post-session jobs...`);
      try {
        settled = await settleSessionCosts(pool, plans, { defaultPromptChars, toolSchemaChars: await chatToolChars() });
      } catch (err) {
        console.warn(`[redteam] cost: app usage not read (${(err as Error).message}); app-side spend excluded`);
      }
    } else {
      settled = { sessions: 0, waitedMs: 0, estimatedChatReplies: 0, estimatedRows: 0, pending: [] };
    }
  }
  for (const e of costLedger) {
    e.result.costUsd = e.cost.usd;
    e.result.cost = e.cost.breakdown();
  }
  const estimatedCategories = [
    ...new Set(
      costLedger.flatMap((e) =>
        Object.entries(e.result.cost?.byCategory ?? {})
          .filter(([, l]) => (l?.estimatedUsd ?? 0) > 0)
          .map(([c]) => c as CostCategory),
      ),
    ),
  ];
  return {
    appUsageRead: !!settled,
    postSessionWaitMs: settled?.waitedMs ?? 0,
    ...costNotes(settled, estimatedCategories, cfg.dryRun),
  };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  let variant: ReturnType<typeof getVariant>;
  try {
    variant = getVariant(cfg.variant);
  } catch (err) {
    console.error(`[redteam] ${(err as Error).message}`);
    process.exit(2);
  }
  const entries = selectSuite(cfg.suite, cfg.scenarioId);
  if (entries.length === 0) {
    console.error(`No scenarios matched (suite=${cfg.suite}, scenario=${cfg.scenarioId ?? 'all'})`);
    process.exit(2);
  }

  console.log(
    `[redteam] suite=${cfg.suite} variant=${variant.name} scenarios=[${entries.map((e) => e.scenario.id).join(', ')}] seed=${cfg.seed} dryRun=${cfg.dryRun}`,
  );

  // Boot the real server in-process (registers routes + sets global.io).
  const { app, io, httpServer } = await import('../server/index.js');
  const { pool } = await import('../server/config/db.js');
  const { CURRENT_CONSENT_VERSION } = await import('../server/utils/consent.js');

  // --config-snapshot <file>: load an environment's evaluated configuration
  // into this (disposable) database first. See configSnapshot.ts. A --variant
  // below still overlays its feature flags on top of the snapshot.
  try {
    await (await import('./configSnapshot.js')).loadConfigSnapshotFromArgv(process.argv.slice(2), pool, cfg.outDir);
  } catch (err) {
    console.error(`[redteam] ${(err as Error).message}`);
    process.exit(2);
  }

  // Variant flags are overlaid in this process only (never written to the DB).
  await applyVariant(variant);
  if (variant.name !== DEFAULT_VARIANT) console.log(`[redteam] variant ${variant.name}: ${variant.description}`);

  const client = new HarnessClient(app, io, CURRENT_CONSENT_VERSION);
  client.patchEmissions();

  // Voice drives a WebSocket through the server's upgrade handler, which needs
  // a listener that outlives one request; bind an ephemeral loopback port for
  // that suite only. HTTP suites stay port-free.
  if (!cfg.dryRun && entries.some((e) => e.scenario.pipeline === 'voice')) {
    const url = await client.listen(httpServer);
    console.log(`[redteam] voice: server listening on ${url} for the proxy WebSocket`);
  }

  // Readiness probe (spec D2): the in-process app answers /health immediately.
  const health = await (await import('supertest')).default(app).get('/health');
  if (health.status !== 200) throw new Error(`server not healthy: ${health.status}`);

  const openai = await makeOpenAI(cfg);
  const canaries = await loadCanaries();

  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  for (const entry of entries) {
    for (let v = 0; v < cfg.variations; v++) {
      const vLabel = cfg.variations > 1 ? ` v${v + 1}/${cfg.variations}` : '';
      console.log(`\n[redteam] running ${entry.scenario.id}${vLabel} (${entry.scenario.pipeline})...`);
      const r = await runEntry(entry, client, openai, cfg, canaries, pool, v);
      console.log(
        `[redteam] ${r.id}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s, harness calls $${r.costUsd.toFixed(4)}; app-side spend is added at the end of the run)`,
      );
      results.push(r);
    }
  }

  // Generated adversarial variants (ai-therapist-109): opt-in, after the
  // scripted scenarios so they can never delay or perturb a scripted result.
  let discardedVariants: DiscardedVariant[] | undefined;
  if (cfg.generatedVariants > 0) {
    const gen = await runGeneratedVariants(entries, client, openai, cfg, canaries, pool);
    results.push(...gen.results);
    discardedVariants = gen.discarded;
  }
  const finishedAt = new Date().toISOString();
  // The per-scenario figures above are the harness's own calls; the app-side
  // spend of each session (replies, assessor, post-session jobs) lands now.
  const costNotesForRun = await settleRunCosts(cfg, pool, await baseChatPromptChars());

  let gitSha: string | null = process.env.GITHUB_SHA ?? null;
  if (!gitSha) {
    try {
      const { execSync } = await import('node:child_process');
      gitSha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      /* not a git checkout */
    }
  }

  // Judge label: what evaluateSession actually ran (the ensemble label from
  // the first judged scenario), else the pinned/default model.
  const judgeLabel =
    results.find((r) => r.judge?.judgeModel)?.judge?.judgeModel ?? cfg.judgeModelOverride ?? cfg.judgeModel;

  const summary: RunSummary = {
    startedAt,
    finishedAt,
    suite: cfg.suite,
    variant: variantLabel(variant),
    seed: cfg.seed,
    judgeModel: judgeLabel,
    gitSha,
    scenarios: results,
    discardedVariants,
    costNotes: costNotesForRun,
  };
  const { junitPath, summaryPath } = writeReports(cfg, summary);
  // A diff from an earlier run in the same --out dir must never be mistaken
  // for this run's (ciSummary.ts renders whatever diff.json is there).
  for (const stale of ['diff.json', 'diff.md'])
    (await import('node:fs')).rmSync(`${cfg.outDir}/${stale}`, { force: true });
  const passed = printConsole(summary);
  reportKnownGaps(results);
  console.log(`[redteam] wrote ${junitPath} and ${summaryPath}`);

  // Persist the run for the admin Simulation Runs panel (phase 3). Best-effort:
  // a missing table (migration 063 not applied) or DB hiccup never fails a run.
  let persistedRunId: number | null = null;
  try {
    const { insertHarnessRun } = await import('../server/db/index.js');
    const trigger =
      process.env.REDTEAM_TRIGGER ??
      (process.env.GITHUB_ACTIONS ? (cfg.suite === 'smoke' ? 'ci-smoke' : 'ci-nightly') : 'manual');
    persistedRunId = await insertHarnessRun({
      startedAt,
      finishedAt,
      // `full:lead-conversation` etc., so `--baseline latest` stays per-variant.
      suite: persistedSuiteLabel(cfg.suite, variant.name),
      seed: cfg.seed,
      variations: cfg.variations,
      judgeModel: judgeLabel,
      gitSha,
      trigger,
      dryRun: cfg.dryRun,
      // Generated variants stay out of harness_runs: the Simulation Runs panel
      // and `--baseline latest` read it as the scripted record. Their record is
      // summary.json plus the persisted scripts under <out>/variants/.
      scenarios: results
        .filter((r) => !r.generated)
        .map((r) => ({
          scenarioId: r.id.replace(/#v\d+$/, ''),
          variation: r.variation,
          pipeline: r.pipeline,
          passed: r.passed,
          assertionFailures: r.assertions
            .filter((a) => !a.passed && a.gating)
            .map((a) => ({ id: a.id, detail: a.detail })),
          judgeScores: r.judge ? (r.judge.scores as Record<string, number>) : null,
          sessionId: r.sessionId ?? null,
          error: r.error ?? null,
          durationMs: r.durationMs,
          costUsd: r.costUsd,
        })),
    });
    console.log(`[redteam] persisted as harness run #${persistedRunId}`);
  } catch (err) {
    console.warn(
      `[redteam] run not persisted (${(err as Error).message}) — apply migration 063 to enable the Simulation Runs panel`,
    );
  }

  // Diff against a baseline (eval spec G4): newly failing/passing assertions
  // and judge-score drops >= 1.0, printed, written next to summary.json, and
  // appended to the GitHub job summary when running in Actions.
  let diffRegressions = false;
  if (cfg.baseline) {
    const diff = await runBaselineDiff(cfg, summary, persistedRunId);
    if (diff) {
      diffRegressions = diff.hasRegressions;
      if (diffRegressions && cfg.gateDiff) console.log('[redteam] --gate-diff: regressions vs baseline -> exit 1');
    } else if (cfg.gateDiff) {
      console.warn('[redteam] --gate-diff: no baseline available, nothing to gate on');
    }
  }

  // Don't pool.end() here: crisis detection runs fire-and-forget writes in
  // setImmediate (incl. best-effort LLM-usage recording) that may still be in
  // flight; ending the pool would make them log "pool after end". process.exit
  // tears everything down cleanly.
  const gateFailed = !passed && !cfg.allowFail;
  const diffFailed = diffRegressions && cfg.gateDiff;
  await flushAndExit(gateFailed || diffFailed ? 1 : 0);
}

/** Plan, generate (or load from cache), guard and run this run's generated
 *  variants. Each runs once (no --variations) under the run seed. */
async function runGeneratedVariants(
  entries: SuiteEntry[],
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  canaries: string[],
  pool: AssertionContext['pool'],
): Promise<{ results: ScenarioResult[]; discarded: DiscardedVariant[] }> {
  console.log(
    `\n[redteam] generated variants: up to ${cfg.generatedVariants} (seed=${cfg.seed}, cache=${cfg.variantCacheDir}, ${cfg.gateGenerated ? 'GATING' : 'non-gating'})`,
  );
  const { variants, discarded } = await buildGeneratedVariants(
    entries,
    cfg.generatedVariants,
    cfg.seed,
    cfg.generatedOperators?.filter(isOperatorId),
    {
      // The OpenAI client satisfies the structural GeneratorClient surface.
      client: openai as unknown as GeneratorClient | null,
      dryRun: cfg.dryRun,
      generatorModel: cfg.generatorModel,
      guardModel: cfg.classifierModel,
      cacheDir: cfg.variantCacheDir,
      runDir: cfg.outDir,
      cost: new CostTracker(),
      safetyIds: new Set(SAFETY_SCENARIOS.map((s) => s.id)),
      log: (m) => console.log(m),
    },
  );
  const results: ScenarioResult[] = [];
  for (const v of variants) {
    const meta: GeneratedVariantMeta = {
      parentId: v.file.parentId,
      operator: v.file.operator,
      seed: v.file.seed,
      gating: cfg.gateGenerated,
      cached: v.cached,
      scriptFile: v.runFile,
    };
    console.log(`\n[redteam] running ${v.file.variantId} (${v.entry.scenario.pipeline})...`);
    const r = await runEntry(v.entry, client, openai, cfg, canaries, pool, 0, {
      meta,
      generationCostUsd: v.costUsd,
    });
    console.log(
      `[redteam] ${r.id}: ${r.passed ? 'PASS' : meta.gating ? 'FAIL' : 'MISS (non-gating)'} (${(r.durationMs / 1000).toFixed(1)}s, $${r.costUsd.toFixed(4)})`,
    );
    results.push(r);
  }
  return { results, discarded };
}

/** Load the baseline named by --baseline: a summary.json path, or `latest`
 *  (newest persisted non-dry run of the same suite, excluding this one). */
async function loadBaseline(cfg: RedteamConfig, persistedRunId: number | null): Promise<NormalizedRun | null> {
  const fs = await import('node:fs');
  if (cfg.baseline === 'latest') {
    try {
      const { getLatestHarnessRunForSuite } = await import('../server/db/index.js');
      const latest = await getLatestHarnessRunForSuite(persistedSuiteLabel(cfg.suite, cfg.variant), persistedRunId);
      if (!latest) {
        console.warn(`[redteam] no previous ${cfg.suite} run persisted in this DB — skipping diff`);
        return null;
      }
      return normalizeHarnessRun(latest.run, latest.results);
    } catch (err) {
      console.warn(`[redteam] could not load latest run from DB (${(err as Error).message}) — skipping diff`);
      return null;
    }
  }
  const path = cfg.baseline as string;
  if (!fs.existsSync(path)) {
    console.warn(`[redteam] baseline ${path} not found — skipping diff`);
    return null;
  }
  try {
    return normalizeSummary(JSON.parse(fs.readFileSync(path, 'utf8')), path);
  } catch (err) {
    console.warn(`[redteam] baseline ${path} unreadable (${(err as Error).message}) — skipping diff`);
    return null;
  }
}

async function runBaselineDiff(
  cfg: RedteamConfig,
  summary: RunSummary,
  persistedRunId: number | null,
): Promise<RunDiff | null> {
  const baseline = await loadBaseline(cfg, persistedRunId);
  if (!baseline) return null;
  const current = normalizeSummary(buildSummaryJson(summary) as Parameters<typeof normalizeSummary>[0], 'this run');
  // A variant only diffs against a baseline of the same variant: comparing a
  // lead-conversation run to a default baseline would report the flag's
  // effect as regressions.
  if (baseline.variant !== current.variant) {
    console.warn(
      `[redteam] baseline ${baseline.source} is variant "${baseline.variant}", this run is "${current.variant}" — skipping diff`,
    );
    return null;
  }
  const diff = diffRuns(baseline, current);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const md = formatDiffMarkdown(diff);
  const diffJsonPath = path.join(cfg.outDir, 'diff.json');
  const diffMdPath = path.join(cfg.outDir, 'diff.md');
  fs.writeFileSync(diffJsonPath, JSON.stringify(diff, null, 2));
  fs.writeFileSync(diffMdPath, md + '\n');
  console.log('\n' + formatDiffConsole(diff));
  console.log(`[redteam] wrote ${diffJsonPath} and ${diffMdPath}`);
  // The GitHub job summary (totals, failures, judge means, this diff) is
  // written by ciSummary.ts from the files above, after the run.
  return diff;
}

/** The booted server keeps the event loop alive (pg adapter LISTEN + io), so we
 *  must process.exit — but a bare exit truncates buffered stdout on a pipe.
 *  Flush both streams first. */
async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>((res) => process.stdout.write('', () => res()));
  await new Promise<void>((res) => process.stderr.write('', () => res()));
  process.exit(code);
}

main().catch(async (err) => {
  console.error('[redteam] fatal:', err);
  await flushAndExit(1);
});
