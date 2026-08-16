// Red-team harness entrypoint (spec §8). Boots the real server in-process,
// drives scripted personas through the chat + realtime-text pipelines, runs
// hard assertions + the v1 judge, writes JUnit/summary, and sets the exit code.
//
//   npx tsx src/redteam/cli.ts --suite smoke
//
// Flags: --suite smoke|full|quality|voice  --scenario <id>  --out <dir>
//        --judge-model <m>  --seed <n>  --variations <k>  --allow-fail  --dry-run
import 'dotenv/config';

// ---- env guards (MUST run before importing server modules) ----------------
// Never page a real on-call from CI (spec R3b). Setting to '' (not delete) so a
// later dotenv.config() in a server module can't re-populate it from .env.
process.env.IMESSAGE_API_KEY = '';
process.env.CRISIS_ALERT_PHONE = '';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import type OpenAI from 'openai';
import { DEFAULTS, CHAT_THERAPY_MODEL, CostTracker, type RedteamConfig } from './config.js';
import { makeClassifier } from './assertions.js';
import { generatePersonaTurn, applyVariation } from './personaDriver.js';
import { runJudge } from './judge.js';
import { HarnessClient, type Agent } from './harnessClient.js';
import { writeReports, printConsole, type RunSummary } from './report.js';
import { selectSuite, type SuiteEntry } from './scenarios/index.js';
import type {
  AssertionContext,
  AssertionResult,
  AssertionSpec,
  Beat,
  Scenario,
  ScenarioResult,
  Turn,
} from './types.js';

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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--suite': {
        const v = next();
        cfg.suite = v === 'smoke' || v === 'quality' || v === 'voice' ? v : 'full';
        break;
      }
      case '--scenario': cfg.scenarioId = next(); break;
      case '--out': cfg.outDir = next(); break;
      case '--judge-model': cfg.judgeModel = next(); break;
      case '--seed': cfg.seed = Number(next()); break;
      case '--variations': cfg.variations = Math.max(1, Number(next()) || 1); break;
      case '--allow-fail': cfg.allowFail = true; break;
      case '--dry-run': cfg.dryRun = true; break;
      default: break;
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
    .filter(l => l.startsWith('## '))
    .map(l => l.trim());
  // De-dup and keep only reasonably distinctive headings.
  return Array.from(new Set(headings)).filter(h => h.length >= 6);
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
  extra?: Partial<Pick<AssertionContext, 'chatSessionEnded' | 'lastMessageStatus' | 'lastMessageBody'>>,
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
      out.push({ id: spec.id, passed: false, detail: `assertion threw: ${(err as Error).message}`, gating: spec.gating !== false });
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
): Promise<{ assertions: AssertionResult[]; judge: ScenarioResult['judge']; judgeBreaches: boolean; sessionId: string }> {
  const agent: Agent = client.newAgent();
  await client.loginParticipant(agent);
  await client.acceptConsent(agent);
  const sessionId = await client.startChat(agent);
  const transcript: Turn[] = [];
  const assertions: AssertionResult[] = [];

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
      cost.estimate(CHAT_THERAPY_MODEL, 700, 260);
      transcript.push({ role: 'assistant', text: reply, beatId: beat.id });
    }

    const ctx = buildCtx(scenario, sessionId, reply, transcript, client, {}, canaries, pool, classify, cfg, beat.id, extra);
    assertions.push(...(await runAssertions(beat.assertAfter, ctx)));
  }

  await client.endChat(agent, sessionId);

  const finalCtx = buildCtx(scenario, sessionId, transcript.at(-1)?.text ?? '', transcript, client, {}, canaries, pool, classify, cfg);
  assertions.push(...(await runAssertions(scenario.assertFinal, finalCtx)));

  let judge: ScenarioResult['judge'] = null;
  let judgeBreaches = false;
  if (runJudgeFlag) {
    const outcome = await runJudge(sessionId, scenario, cfg, cost);
    if (outcome) {
      judge = outcome.scores;
      judgeBreaches = outcome.breaches.length > 0;
    }
  }
  return { assertions, judge, judgeBreaches, sessionId };
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
): Promise<{ assertions: AssertionResult[]; judge: ScenarioResult['judge']; judgeBreaches: boolean; sessionId: string }> {
  const agent: Agent = client.newAgent();
  await client.acceptConsent(agent);
  const sessionId = `redteam_rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const transcript: Turn[] = [];
  const assertions: AssertionResult[] = [];
  const beatPostTimes: Record<string, Date> = {};

  for (const beat of beats) {
    const utter = beat.verbatim ?? (await generatePersonaTurn(openai as OpenAI, cost, cfg, scenario, beat, transcript));
    beatPostTimes[beat.id] = new Date();
    await client.postParticipantTurn(agent, sessionId, utter);
    await client.postAssistantStub(agent, sessionId, SAFE_ASSISTANT_STUB);
    transcript.push({ role: 'user', text: utter, beatId: beat.id });
    transcript.push({ role: 'assistant', text: SAFE_ASSISTANT_STUB, beatId: beat.id });

    const ctx = buildCtx(scenario, sessionId, '', transcript, client, beatPostTimes, canaries, pool, classify, cfg, beat.id);
    assertions.push(...(await runAssertions(beat.assertAfter, ctx)));
  }

  // End the realtime session so the judge (which requires status='ended') runs.
  const { updateSessionStatus } = await import('../server/db/index.js');
  await updateSessionStatus(sessionId, 'ended', 'user');

  const finalCtx = buildCtx(scenario, sessionId, '', transcript, client, beatPostTimes, canaries, pool, classify, cfg);
  assertions.push(...(await runAssertions(scenario.assertFinal, finalCtx)));

  let judge: ScenarioResult['judge'] = null;
  let judgeBreaches = false;
  if (runJudgeFlag) {
    const outcome = await runJudge(sessionId, scenario, cfg, cost);
    if (outcome) {
      judge = outcome.scores;
      judgeBreaches = outcome.breaches.length > 0;
    }
  }
  return { assertions, judge, judgeBreaches, sessionId };
}

async function runEntry(
  entry: SuiteEntry,
  client: HarnessClient,
  openai: OpenAI | null,
  cfg: RedteamConfig,
  canaries: string[],
  pool: AssertionContext['pool'],
  variation = 0,
): Promise<ScenarioResult> {
  // Variation v>0: styled persona + shifted seed; ids get a #v2/#v3 suffix so
  // reports and the DB keep each variation as its own row.
  const scenario = applyVariation(entry.scenario, variation);
  const vcfg: RedteamConfig = variation > 0 ? { ...cfg, seed: cfg.seed + variation } : cfg;
  const label = variation > 0 ? `${scenario.id}#v${variation + 1}` : scenario.id;
  const beats = entry.beatIds ? scenario.beats.filter(b => entry.beatIds!.includes(b.id)) : scenario.beats;
  const runJudgeFlag = entry.judge ?? scenario.runJudge;
  const cost = new CostTracker();
  const classify = makeClassifier(openai, vcfg, cost);
  const start = Date.now();

  try {
    // Voice needs a live OpenAI client (TTS + Realtime WS); in dry-run it
    // falls back to the realtime-text flow so the offline pipeline completes.
    const runner =
      scenario.pipeline === 'chat' ? runChatScenario :
      scenario.pipeline === 'voice' && !cfg.dryRun ? (await import('./voiceClient.js')).runVoiceScenario :
      runRealtimeScenario;
    const { assertions, judge, judgeBreaches, sessionId } = await runner(
      scenario, beats, runJudgeFlag, client, openai, vcfg, cost, canaries, pool, classify,
    );
    const gatingFail = assertions.some(a => !a.passed && a.gating) || judgeBreaches;
    return {
      id: label,
      title: scenario.title,
      pipeline: scenario.pipeline,
      variation,
      passed: !gatingFail,
      assertions,
      judge,
      sessionId,
      costUsd: cost.usd,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
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
    };
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const entries = selectSuite(cfg.suite, cfg.scenarioId);
  if (entries.length === 0) {
    console.error(`No scenarios matched (suite=${cfg.suite}, scenario=${cfg.scenarioId ?? 'all'})`);
    process.exit(2);
  }

  console.log(`[redteam] suite=${cfg.suite} scenarios=[${entries.map(e => e.scenario.id).join(', ')}] seed=${cfg.seed} dryRun=${cfg.dryRun}`);

  // Boot the real server in-process (registers routes + sets global.io).
  const { app, io } = await import('../server/index.js');
  const { pool } = await import('../server/config/db.js');
  const { CURRENT_CONSENT_VERSION } = await import('../server/utils/consent.js');

  const client = new HarnessClient(app, io, CURRENT_CONSENT_VERSION);
  client.patchEmissions();

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
      console.log(`[redteam] ${r.id}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s, $${r.costUsd.toFixed(4)})`);
      results.push(r);
    }
  }
  const finishedAt = new Date().toISOString();

  const summary: RunSummary = {
    startedAt,
    finishedAt,
    suite: cfg.suite,
    seed: cfg.seed,
    judgeModel: cfg.judgeModel,
    scenarios: results,
  };
  const { junitPath, summaryPath } = writeReports(cfg, summary);
  const passed = printConsole(summary);
  console.log(`[redteam] wrote ${junitPath} and ${summaryPath}`);

  // Persist the run for the admin Simulation Runs panel (phase 3). Best-effort:
  // a missing table (migration 063 not applied) or DB hiccup never fails a run.
  try {
    const { insertHarnessRun } = await import('../server/db/index.js');
    let gitSha: string | null = process.env.GITHUB_SHA ?? null;
    if (!gitSha) {
      try {
        const { execSync } = await import('node:child_process');
        gitSha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch { /* not a git checkout */ }
    }
    const trigger = process.env.REDTEAM_TRIGGER
      ?? (process.env.GITHUB_ACTIONS ? (cfg.suite === 'smoke' ? 'ci-smoke' : 'ci-nightly') : 'manual');
    const runId = await insertHarnessRun({
      startedAt, finishedAt,
      suite: cfg.suite, seed: cfg.seed, variations: cfg.variations,
      judgeModel: cfg.judgeModel, gitSha, trigger, dryRun: cfg.dryRun,
      scenarios: results.map(r => ({
        scenarioId: r.id.replace(/#v\d+$/, ''),
        variation: r.variation,
        pipeline: r.pipeline,
        passed: r.passed,
        assertionFailures: r.assertions.filter(a => !a.passed && a.gating).map(a => ({ id: a.id, detail: a.detail })),
        judgeScores: r.judge ? (r.judge.scores as Record<string, number>) : null,
        sessionId: r.sessionId ?? null,
        error: r.error ?? null,
        durationMs: r.durationMs,
        costUsd: r.costUsd,
      })),
    });
    console.log(`[redteam] persisted as harness run #${runId}`);
  } catch (err) {
    console.warn(`[redteam] run not persisted (${(err as Error).message}) — apply migration 063 to enable the Simulation Runs panel`);
  }

  // Don't pool.end() here: crisis detection runs fire-and-forget writes in
  // setImmediate (incl. best-effort LLM-usage recording) that may still be in
  // flight; ending the pool would make them log "pool after end". process.exit
  // tears everything down cleanly.
  await flushAndExit(!passed && !cfg.allowFail ? 1 : 0);
}

/** The booted server keeps the event loop alive (pg adapter LISTEN + io), so we
 *  must process.exit — but a bare exit truncates buffered stdout on a pipe.
 *  Flush both streams first. */
async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>(res => process.stdout.write('', () => res()));
  await new Promise<void>(res => process.stderr.write('', () => res()));
  process.exit(code);
}

main().catch(async err => {
  console.error('[redteam] fatal:', err);
  await flushAndExit(1);
});
