// Goldens runner (docs/redteam.md "Goldens"). Boots the real server in-process,
// like src/redteam/cli.ts, and runs every row of a golden set through the real
// path once:
//
//   detector  each row is a fresh session. History is replayed turn by turn
//             (participant turns are scored as they arrive), then the input is
//             posted and the input's own risk score, the session's crisis flag
//             and any page record are read back from the database.
//               rt-text: POST /logs/batch, the route the harness's realtime-text
//                        flow uses, with the history's assistant turns logged
//                        between participant turns.
//               chat:    the participant turn is persisted and runCrisisPipeline
//                        (channel 'chat') is called in-process, exactly what
//                        /api/chat/message runs before (or after) its model
//                        call; the model reply itself is skipped, so a detector
//                        row never pays for a chat reply.
//   reply     each row is a fresh chat session (/api/chat/start). The fixed
//             history is written to the session's messages, its participant
//             turns are scored, the in-memory model context is rebuilt from
//             the database (rehydrateChatSession), and the input is sent once
//             through /api/chat/message. The reply is graded with the row's
//             phrase and regex checks, then its yes/no questions.
//
//   npm run redteam:goldens -- --set detector --layer keyword
//   npm run redteam:goldens -- --set detector --layer full
//   npm run redteam:goldens -- --set reply
//   npm run redteam:goldens -- --review-sheet       (rebuild the review CSVs)
//   npm run redteam:goldens -- --check              (validate the data only)
//
// Flags: --set detector|reply  --layer keyword|full (detector only)
//        --dry-run (no OpenAI calls at all; reply rows get a canned reply)
//        --ids a,b  --category c  --limit n  --out <dir>  --baseline <summary.json>
//        --max-usd n (stop before recorded spend passes n; default 2)
//
// `--layer keyword` runs with no OpenAI key in the process: the risk assessor
// and the free moderation screen both fail fast, so every score is the stage-1
// keyword tier plus the context-signal fallback, which is what production
// scores while the assessor is down. Nothing is sent anywhere and it costs
// nothing. `--layer full` is the production pipeline (assessor, moderation).
//
// Needs DATABASE_URL pointing at an EMPTY, disposable database built with
// scripts/redteam-db-setup.sh. Never stage or prod.
import 'dotenv/config';

// ---- env guards (MUST run before importing server modules) ----------------
// Same guards as src/redteam/cli.ts: nothing this process does may page a
// person or reach a live dashboard.
process.env.IMESSAGE_API_KEY = '';
process.env.CRISIS_ALERT_PHONE = '';
process.env.SOCKET_PG_ADAPTER = 'off';
process.env.NODE_ENV = 'test';
// Quiet hours (when a deployment enables them) block new participant sessions
// overnight; a disposable eval database is not a participant.
process.env.QUIET_HOURS_ENABLED = 'false';

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import { CostTracker, DEFAULTS, priceTokens, type RedteamConfig } from '../config.js';
import { makeClassifier, PAGING_KIND_SQL } from '../assertions.js';
import type { CapturedEmission, DbLike } from '../types.js';
import { loadDetectorGoldens, loadReplyGoldens, REPO_ROOT } from './load.js';
import { bandForScore, type DetectorRow, type ReplyRow } from './schema.js';
import {
  diffRows,
  formatDetectorMarkdown,
  formatDiffMarkdown,
  scoreDetectorRow,
  summarizeDetector,
  type DetectorObservation,
  type DetectorRowResult,
  type DiffableRow,
  type RowDiff,
} from './detectorReport.js';
import { gradeReply, type ReplyGrade } from './replyGrade.js';
import { writeReviewSheets } from './reviewSheet.js';

type GoldenSet = 'detector' | 'reply';
type Layer = 'keyword' | 'full';

interface Args {
  set: GoldenSet;
  layer: Layer;
  dryRun: boolean;
  ids?: string[];
  category?: string;
  limit?: number;
  out?: string;
  baseline?: string;
  maxUsd: number;
  reviewSheet: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { set: 'detector', layer: 'keyword', dryRun: false, maxUsd: 2, reviewSheet: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--set': {
        const v = next();
        if (v !== 'detector' && v !== 'reply') throw new Error(`--set must be detector or reply (got ${v})`);
        a.set = v;
        break;
      }
      case '--layer': {
        const v = next();
        if (v !== 'keyword' && v !== 'full') throw new Error(`--layer must be keyword or full (got ${v})`);
        a.layer = v;
        break;
      }
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--ids':
        a.ids = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--category':
        a.category = next();
        break;
      case '--limit':
        a.limit = Number(next());
        break;
      case '--out':
        a.out = next();
        break;
      case '--baseline':
        a.baseline = next();
        break;
      case '--max-usd':
        a.maxUsd = Number(next());
        break;
      case '--review-sheet':
        a.reviewSheet = true;
        break;
      case '--check':
        a.check = true;
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  if (a.dryRun) a.layer = 'keyword';
  return a;
}

/** A call was refused because the OpenAI account is out of credit or over its
 *  spend limit. This account also serves live sessions: stop everything. */
class QuotaExhaustedError extends Error {}

function looksLikeQuota(text: string): boolean {
  return /insufficient_quota|no credits remaining|exceeded your current quota|billing_hard_limit|spend limit/i.test(
    text,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared server plumbing
// ---------------------------------------------------------------------------

interface Env {
  pool: DbLike;
  client: import('../harnessClient.js').HarnessClient;
  emissions: CapturedEmission[];
}

/** Spend the app recorded for these sessions (session_llm_usage), priced at
 *  the harness's rates. Rows without token counts are counted, not priced. */
async function recordedAppSpend(
  pool: DbLike,
  sessionIds: string[],
): Promise<{
  usd: number;
  calls: number;
  unrecordedCalls: number;
  byPurpose: Record<string, { usd: number; calls: number; tokensIn: number; tokensOut: number }>;
}> {
  const out = {
    usd: 0,
    calls: 0,
    unrecordedCalls: 0,
    byPurpose: {} as Record<string, { usd: number; calls: number; tokensIn: number; tokensOut: number }>,
  };
  if (sessionIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT purpose, model, tokens_in, tokens_out FROM session_llm_usage WHERE session_id = ANY($1::text[])`,
    [sessionIds],
  );
  for (const r of rows) {
    out.calls++;
    const p = (out.byPurpose[String(r.purpose)] ??= { usd: 0, calls: 0, tokensIn: 0, tokensOut: 0 });
    p.calls++;
    if (r.tokens_in == null && r.tokens_out == null) {
      out.unrecordedCalls++;
      continue;
    }
    const tin = Number(r.tokens_in ?? 0);
    const tout = Number(r.tokens_out ?? 0);
    const usd = priceTokens(String(r.model ?? 'default'), tin, tout);
    p.usd += usd;
    p.tokensIn += tin;
    p.tokensOut += tout;
    out.usd += usd;
  }
  return out;
}

/** /logs/batch with the per-IP limiter respected (120/min): a 429 waits for
 *  the window, then the same record is posted again. Resolves once the
 *  route's after-response processing (crisis pipeline, then the
 *  session:activity emission) has finished for this session. */
async function postLog(
  env: Env,
  agent: import('../harnessClient.js').Agent,
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = env.emissions.length;
    const res = await agent.post('/logs/batch').send({
      records: [{ timestamp: new Date().toISOString(), sessionId, role, type: 'text', message: text, extras: null }],
    });
    if (res.status === 429) {
      const reset = Number(res.headers?.['ratelimit-reset']) || 60;
      console.warn(`[goldens] /logs/batch rate-limited; waiting ${reset}s`);
      await sleep((reset + 1) * 1000);
      continue;
    }
    if (res.status !== 200) throw new Error(`/logs/batch failed: ${res.status} ${res.text}`);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const done = env.emissions.slice(before).some((e) => {
        if (e.event !== 'session:activity') return false;
        if (e.room === 'admin-broadcast')
          return (e.payload as { sessionId?: string } | undefined)?.sessionId === sessionId;
        return e.room.includes(sessionId);
      });
      if (done) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for /logs/batch processing of ${sessionId}`);
  }
  throw new Error('/logs/batch still rate-limited after 3 attempts');
}

/** Pages the DETECTOR produced (paging.kind = 'risk'). A vendor cut or the
 *  vendor ceiling also writes a 'crisis_sms_alert' row since the paging policy
 *  of 2026-11-18; counting those would credit the detector with a page it did
 *  not ask for (see interventionLogged in ../assertions.ts). */
async function countPages(pool: DbLike, sessionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM intervention_actions
      WHERE session_id = $1 AND action_type = 'crisis_sms_alert' AND ${PAGING_KIND_SQL} = 'risk'`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function countHighResponses(pool: DbLike, sessionId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM intervention_actions WHERE session_id = $1 AND action_type = 'high_risk_emergency'`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Detector set
// ---------------------------------------------------------------------------

interface DetectorRunRow extends DetectorRowResult {
  sessionId: string;
  /** The assessor was asked to score the input and could not (llm_error). */
  assessmentDegraded: boolean;
  llmError: string | null;
  costUsd: number;
}

async function runDetectorRow(
  env: Env,
  row: DetectorRow,
): Promise<{ obs: DetectorObservation; sessionId: string; llmError: string | null }> {
  const { pool, client } = env;
  const sessionId = `redteam_gold_${row.id.replace(/[^a-z0-9]/g, '')}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const db = await import('../../server/db/index.js');
  let inputMessageId: number | null = null;
  let pagesBefore = 0;
  let highBefore = 0;
  try {
    if (row.modality === 'rt-text') {
      const agent = client.newAgent();
      await client.acceptConsent(agent);
      client.noteSession(sessionId);
      for (const t of row.history) await postLog(env, agent, sessionId, t.role, t.text);
      pagesBefore = await countPages(pool, sessionId).catch(() => 0);
      highBefore = await countHighResponses(pool, sessionId).catch(() => 0);
      await postLog(env, agent, sessionId, 'user', row.input);
      const { rows } = await pool.query(
        `SELECT message_id FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY message_id DESC LIMIT 1`,
        [sessionId],
      );
      inputMessageId = rows[0] ? Number(rows[0].message_id) : null;
    } else {
      // Chat channel, in-process: what /api/chat/message runs for detection.
      const { runCrisisPipeline } = await import('../../server/services/crisisPipeline.service.js');
      await db.createActiveRealtimeSession(sessionId, null, true);
      client.noteSession(sessionId);
      const send = async (role: 'user' | 'assistant', text: string): Promise<number> => {
        const [m] = await db.insertMessagesBatch([
          { session_id: sessionId, role, message_type: 'text', content: text, content_redacted: null },
        ]);
        if (role === 'user') {
          await runCrisisPipeline({ sessionId, messageId: m.message_id, content: text }, 'chat');
        }
        return Number(m.message_id);
      };
      for (const t of row.history) await send(t.role, t.text);
      pagesBefore = await countPages(pool, sessionId);
      highBefore = await countHighResponses(pool, sessionId);
      inputMessageId = await send('user', row.input);
    }

    const { rows: risk } = await pool.query(
      `SELECT risk_score, score_factors FROM risk_score_history WHERE session_id = $1 AND message_id = $2
       ORDER BY history_id DESC LIMIT 1`,
      [sessionId, inputMessageId],
    );
    // pageOnCall runs fire-and-forget after the high-risk response is logged:
    // when this input produced one, give the page row time to land.
    let pages = await countPages(pool, sessionId);
    if ((await countHighResponses(pool, sessionId)) > highBefore) {
      for (let i = 0; i < 30 && pages <= pagesBefore; i++) {
        await sleep(100);
        pages = await countPages(pool, sessionId);
      }
    }
    const { rows: flag } = await pool.query(
      `SELECT crisis_flagged, crisis_severity FROM therapy_sessions WHERE session_id = $1`,
      [sessionId],
    );
    const factors = (risk[0]?.score_factors ?? {}) as { method?: string; llm_error?: string };
    return {
      sessionId,
      llmError: factors.llm_error ?? null,
      obs: {
        id: row.id,
        riskScore: risk[0] ? Number(risk[0].risk_score) : null,
        method: factors.method ?? null,
        paged: pages > pagesBefore,
        flagged: flag[0]?.crisis_flagged === true,
        flagSeverity: (flag[0]?.crisis_severity as string | null) ?? null,
        ...(risk[0] ? {} : { error: 'no risk_score_history row for the input' }),
      },
    };
  } catch (err) {
    return {
      sessionId,
      llmError: null,
      obs: {
        id: row.id,
        riskScore: null,
        method: null,
        paged: false,
        flagged: false,
        flagSeverity: null,
        error: (err as Error).message,
      },
    };
  } finally {
    await db.updateSessionStatus(sessionId, 'ended', 'user').catch(() => undefined);
  }
}

async function runDetector(
  env: Env,
  args: Args,
  rows: DetectorRow[],
): Promise<{
  results: DetectorRunRow[];
  stopped: string | null;
  costUsd: number;
  cost: Awaited<ReturnType<typeof recordedAppSpend>>;
}> {
  const results: DetectorRunRow[] = [];
  const sessionIds: string[] = [];
  let stopped: string | null = null;
  let spent = 0;
  for (const [i, row] of rows.entries()) {
    const { obs, sessionId, llmError } = await runDetectorRow(env, row);
    sessionIds.push(sessionId);
    const scored = scoreDetectorRow(row, obs, bandForScore);
    let rowCost = 0;
    if (args.layer === 'full') {
      await sleep(150); // usage rows are written fire-and-forget
      rowCost = (await recordedAppSpend(env.pool, [sessionId])).usd;
      spent += rowCost;
    }
    results.push({
      ...scored,
      sessionId,
      assessmentDegraded: llmError !== null,
      llmError,
      costUsd: Number(rowCost.toFixed(6)),
    });
    console.log(
      `[goldens] ${String(i + 1).padStart(3)}/${rows.length} ${scored.correct ? 'ok  ' : scored.knownGap ? 'gap ' : 'MISS'} ${row.id}: ` +
        `expected ${row.expected.band}/${row.expected.page} observed ${scored.observedBand ?? 'error'}` +
        `${obs.riskScore !== null ? ` (${obs.riskScore}, ${obs.method})` : ''}${obs.paged ? ' paged' : ''}` +
        `${obs.error ? ` ERROR ${obs.error}` : ''}${args.layer === 'full' && llmError ? ` [assessor ${llmError}]` : ''}`,
    );
    if (args.layer === 'full' && llmError === 'quota') {
      stopped = `the risk assessor was refused for quota on ${row.id}; all API work stopped`;
      break;
    }
    if (spent >= args.maxUsd) {
      stopped = `recorded spend $${spent.toFixed(4)} reached --max-usd ${args.maxUsd} after ${row.id}`;
      break;
    }
  }
  await sleep(1000);
  const cost = await recordedAppSpend(env.pool, sessionIds);
  return { results, stopped, costUsd: cost.usd, cost };
}

// ---------------------------------------------------------------------------
// Reply set
// ---------------------------------------------------------------------------

interface ReplyRunRow extends ReplyGrade {
  sessionId: string | null;
  input: string;
  reply: string;
  sessionEnded: boolean;
  costUsd: number;
  error?: string;
}

const DRY_RUN_REPLY =
  "[dry-run reply] I'm really glad you told me. I'm an AI, not a therapist or a crisis service. If you might act on " +
  'thoughts of ending your life, please call or text 988 now. Can you tell me more?';

async function startChat(agent: import('../harnessClient.js').Agent): Promise<string> {
  const db = await import('../../server/db/index.js');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await agent.post('/api/chat/start').send({ language: 'en' });
    const reset = Number(res.headers?.['ratelimit-reset']);
    if (res.status === 429 && !res.body?.error && Number.isFinite(reset) && reset <= 16 * 60) {
      console.warn(`[goldens] chat start rate-limited (20 per 15 min per IP); waiting ${reset}s`);
      await sleep((reset + 1) * 1000);
      continue;
    }
    if (res.status !== 200 || !res.body?.sessionId)
      throw new Error(`chat start failed: ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.alreadyActive === true) {
      // A previous row's session survived (it should not): close it in the
      // database, not through /api/chat/end, which starts billed jobs.
      await db.updateSessionStatus(String(res.body.sessionId), 'ended', 'user');
      continue;
    }
    return String(res.body.sessionId);
  }
  throw new Error('chat start did not return a fresh session');
}

async function runReplyRow(
  env: Env,
  agent: import('../harnessClient.js').Agent,
  row: ReplyRow,
  args: Args,
  classify: ReturnType<typeof makeClassifier>,
): Promise<ReplyRunRow> {
  const db = await import('../../server/db/index.js');
  let sessionId: string | null = null;
  try {
    sessionId = await startChat(agent);
    env.client.noteSession(sessionId);
    const { runCrisisPipeline } = await import('../../server/services/crisisPipeline.service.js');
    const { rehydrateChatSession, injectGuidance } = await import('../../server/services/chatTherapy.service.js');
    // Fixed history, written after the server-authored opening with
    // increasing timestamps so the rebuilt context keeps the order.
    const base = Date.now();
    const guidance: string[] = [];
    for (const [i, t] of row.history.entries()) {
      const [m] = await db.insertMessagesBatch([
        {
          session_id: sessionId,
          role: t.role,
          message_type: 'text',
          content: t.text,
          content_redacted: null,
          created_at: new Date(base + i * 10),
        },
      ]);
      if (t.role === 'user' && !args.dryRun) {
        const r = await runCrisisPipeline({ sessionId, messageId: m.message_id, content: t.text }, 'chat');
        if (r.steeringGuidance) guidance.push(r.steeringGuidance);
      }
    }
    await rehydrateChatSession(sessionId);
    // Steering a history turn earned would have stayed in the live context.
    for (const g of guidance) injectGuidance(sessionId, g);

    let reply = DRY_RUN_REPLY;
    let sessionEnded = false;
    if (!args.dryRun) {
      const res = await agent.post('/api/chat/message').send({ sessionId, message: row.input });
      if (res.status !== 200 || typeof res.body?.response !== 'string') {
        const body = JSON.stringify(res.body);
        if (looksLikeQuota(body)) throw new QuotaExhaustedError(`chat reply refused for quota: ${body.slice(0, 200)}`);
        throw new Error(`chat message failed: ${res.status} ${body.slice(0, 300)}`);
      }
      reply = res.body.response as string;
      sessionEnded = res.body.sessionEnded === true;
    }
    const grade = await gradeReply(row, reply, sessionEnded, classify);
    for (const c of grade.checks) {
      if (c.kind === 'criterion' && looksLikeQuota(c.detail))
        throw new QuotaExhaustedError(`classifier refused for quota on ${row.id}`);
    }
    return { ...grade, sessionId, input: row.input, reply, sessionEnded, costUsd: 0 };
  } catch (err) {
    if (err instanceof QuotaExhaustedError || looksLikeQuota(String((err as Error).message))) {
      throw err instanceof QuotaExhaustedError ? err : new QuotaExhaustedError((err as Error).message);
    }
    return {
      id: row.id,
      category: row.category,
      passed: false,
      deterministicPassed: false,
      checks: [],
      reviewed: row.reviewedBy !== null,
      ...(row.knownGap ? { knownGap: row.knownGap } : {}),
      sessionId,
      input: row.input,
      reply: '',
      sessionEnded: false,
      costUsd: 0,
      error: (err as Error).message,
    };
  } finally {
    // Close in the database: /api/chat/end would start the billed
    // post-session jobs (redaction, insights), which no golden needs.
    if (sessionId) await db.updateSessionStatus(sessionId, 'ended', 'user').catch(() => undefined);
  }
}

async function runReplies(
  env: Env,
  args: Args,
  rows: ReplyRow[],
  openai: OpenAI | null,
): Promise<{
  results: ReplyRunRow[];
  stopped: string | null;
  costUsd: number;
  classifierUsd: number;
  cost: Awaited<ReturnType<typeof recordedAppSpend>>;
}> {
  const cfg = { ...DEFAULTS, dryRun: args.dryRun } as RedteamConfig;
  const tracker = new CostTracker();
  const classify = makeClassifier(openai, cfg, tracker);
  const agent = env.client.newAgent();
  await env.client.loginParticipant(agent);
  await env.client.acceptConsent(agent);
  const results: ReplyRunRow[] = [];
  const sessionIds: string[] = [];
  let stopped: string | null = null;
  for (const [i, row] of rows.entries()) {
    const usdBefore = tracker.usd;
    let r: ReplyRunRow;
    try {
      r = await runReplyRow(env, agent, row, args, classify);
    } catch (err) {
      stopped = `${(err as Error).message}; all API work stopped`;
      break;
    }
    if (r.sessionId) sessionIds.push(r.sessionId);
    await sleep(200);
    const app = r.sessionId ? (await recordedAppSpend(env.pool, [r.sessionId])).usd : 0;
    r.costUsd = Number((app + tracker.usd - usdBefore).toFixed(6));
    results.push(r);
    console.log(
      `[goldens] ${String(i + 1).padStart(3)}/${rows.length} ${r.passed ? 'pass' : r.knownGap ? 'gap ' : 'FAIL'} ${row.id}` +
        `${r.error ? ` ERROR ${r.error}` : ''} $${r.costUsd.toFixed(4)}`,
    );
    for (const c of r.checks.filter((x) => !x.passed)) console.log(`        x ${c.id}: ${c.detail.slice(0, 220)}`);
    const spent = (await recordedAppSpend(env.pool, sessionIds)).usd + tracker.breakdown().recordedUsd;
    if (spent >= args.maxUsd) {
      stopped = `recorded spend $${spent.toFixed(4)} reached --max-usd ${args.maxUsd} after ${row.id}`;
      break;
    }
  }
  await sleep(1000);
  const cost = await recordedAppSpend(env.pool, sessionIds);
  const classifierUsd = tracker.breakdown().recordedUsd;
  return { results, stopped, costUsd: cost.usd + classifierUsd, classifierUsd, cost };
}

function formatReplyMarkdown(
  results: ReplyRunRow[],
  meta: { costUsd: number; diff: RowDiff | null; total: number },
): string {
  const passed = results.filter((r) => r.passed).length;
  const reviewed = results.filter((r) => r.reviewed).length;
  const det = results.filter((r) => r.deterministicPassed).length;
  const lines = [
    '# Reply goldens',
    '',
    `${reviewed} of ${results.length} rows human-reviewed${results.length < meta.total ? ` (${meta.total} in the set; the run stopped or was filtered)` : ''}. Recorded cost $${meta.costUsd.toFixed(4)}.`,
    '',
    `- Pass rate: ${passed}/${results.length} (${results.length ? ((passed / results.length) * 100).toFixed(1) : '0'}%).`,
    `- Deterministic checks alone: ${det}/${results.length} rows pass.`,
    `- Errored rows: ${results.filter((r) => r.error).length}.`,
    '',
    '## Per category',
    '',
    '| category | rows | pass |',
    '|---|---:|---:|',
  ];
  const cats = new Map<string, { n: number; p: number }>();
  for (const r of results) {
    const c = cats.get(r.category) ?? { n: 0, p: 0 };
    c.n++;
    if (r.passed) c.p++;
    cats.set(r.category, c);
  }
  for (const [cat, c] of [...cats].sort()) lines.push(`| ${cat} | ${c.n} | ${c.p} |`);
  lines.push('', '## Failing rows', '');
  for (const r of results.filter((x) => !x.passed)) {
    lines.push(`### ${r.id}${r.knownGap ? ` (known gap ${r.knownGap})` : ''}`);
    lines.push('', `Participant: ${r.input}`, '');
    if (r.error) lines.push(`Error: ${r.error}`, '');
    for (const c of r.checks.filter((x) => !x.passed)) lines.push(`- ${c.id}: ${c.detail}`);
    if (r.reply) lines.push('', '> ' + r.reply.replace(/\n+/g, '\n> '), '');
  }
  if (meta.diff) lines.push('', formatDiffMarkdown(meta.diff));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function select<T extends { id: string; category: string }>(rows: T[], args: Args): T[] {
  let out = rows;
  if (args.ids) out = out.filter((r) => args.ids!.includes(r.id));
  if (args.category) out = out.filter((r) => r.category === args.category);
  if (args.limit && args.limit > 0) out = out.slice(0, args.limit);
  return out;
}

function gitSha(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function loadBaseline(file: string): DiffableRow[] | null {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows?: DiffableRow[] };
    return Array.isArray(json.rows) ? json.rows.map((r) => ({ ...r, correct: r.correct ?? r.passed ?? false })) : null;
  } catch (err) {
    console.warn(`[goldens] baseline ${file} unreadable (${(err as Error).message}); no diff`);
    return null;
  }
}

async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>((res) => process.stdout.write('', () => res()));
  await new Promise<void>((res) => process.stderr.write('', () => res()));
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const detector = loadDetectorGoldens();
  const reply = loadReplyGoldens();
  const errors = [...detector.errors, ...reply.errors];
  if (errors.length) {
    console.error(`[goldens] ${errors.length} problem(s) in the golden data:\n  ${errors.join('\n  ')}`);
    await flushAndExit(2);
  }
  if (args.check) {
    console.log(`[goldens] data OK: ${detector.rows.length} detector rows, ${reply.rows.length} reply rows`);
    await flushAndExit(0);
  }
  if (args.reviewSheet) {
    for (const p of writeReviewSheets(detector.rows, reply.rows))
      console.log(`[goldens] wrote ${path.relative(REPO_ROOT, p)}`);
    await flushAndExit(0);
  }

  const offline = args.dryRun || (args.set === 'detector' && args.layer === 'keyword');
  // Several server modules read the key at import time, so the boot needs one;
  // an offline run then removes it before any detection call (below).
  if (!process.env.OPENAI_API_KEY) {
    if (!offline) throw new Error('OPENAI_API_KEY is required for --layer full and the reply set (or pass --dry-run)');
    process.env.OPENAI_API_KEY = 'sk-goldens-offline-placeholder';
  }

  const { app, io } = await import('../../server/index.js');
  const { pool } = await import('../../server/config/db.js');
  const { CURRENT_CONSENT_VERSION } = await import('../../server/utils/consent.js');
  const { HarnessClient } = await import('../harnessClient.js');
  const client = new HarnessClient(app, io, CURRENT_CONSENT_VERSION);
  client.patchEmissions();
  const env: Env = { pool, client, emissions: client.emissions };

  let openai: OpenAI | null = null;
  if (offline) {
    // No key from here on: the assessor, moderation and minor-confirmation
    // clients are created lazily, so each call now fails before any network.
    process.env.OPENAI_API_KEY = '';
  } else {
    const OpenAIClass = (await import('openai')).default;
    openai = new OpenAIClass({ apiKey: process.env.OPENAI_API_KEY });
  }

  const layerLabel =
    args.set === 'detector' ? (args.dryRun ? 'keyword (dry-run)' : args.layer) : args.dryRun ? 'dry-run' : 'chat';
  const outDir = path.resolve(
    args.out ?? path.join('redteam-results', 'goldens', args.set === 'detector' ? `detector-${args.layer}` : 'reply'),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const summaryPath = path.join(outDir, 'summary.json');
  // Without --baseline, the previous run in the same directory is the baseline.
  let baselineFile = args.baseline ?? null;
  if (!baselineFile && fs.existsSync(summaryPath)) {
    baselineFile = path.join(outDir, 'previous-summary.json');
    fs.copyFileSync(summaryPath, baselineFile);
  }

  const startedAt = new Date().toISOString();
  let code = 0;
  if (args.set === 'detector') {
    const rows = select(detector.rows, args);
    console.log(
      `[goldens] detector: ${rows.length} row(s), layer=${layerLabel}, out=${path.relative(process.cwd(), outDir)}`,
    );
    const run = await runDetector(env, args, rows);
    const summary = summarizeDetector(run.results);
    const baseline = baselineFile ? loadBaseline(baselineFile) : null;
    const diff = baseline
      ? diffRows(baseline, run.results, path.relative(process.cwd(), baselineFile as string))
      : null;
    const md = formatDetectorMarkdown(summary, run.results, { layer: layerLabel, costUsd: run.costUsd, diff });
    const degraded = run.results.filter((r) => r.assessmentDegraded).length;
    const json = {
      set: 'detector',
      layer: layerLabel,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitSha: gitSha(),
      totalRowsInSet: detector.rows.length,
      stopped: run.stopped,
      cost: {
        recordedUsd: Number(run.costUsd.toFixed(6)),
        appCalls: run.cost.calls,
        callsWithoutTokenCounts: run.cost.unrecordedCalls,
        byPurpose: run.cost.byPurpose,
        note: 'Recorded = token counts the app wrote to session_llm_usage, priced at src/redteam/config.ts rates. The moderation screen is free and not listed.',
      },
      assessmentDegradedRows: args.layer === 'full' ? degraded : undefined,
      summary,
      diff,
      rows: run.results,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(json, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'report.md'), md);
    console.log('\n' + md);
    if (args.layer === 'full' && degraded)
      console.warn(`[goldens] ${degraded} row(s) were scored with the assessor failing (assessment_degraded)`);
    if (run.stopped) {
      console.error(`[goldens] STOPPED: ${run.stopped}`);
      code = 3;
    }
  } else {
    const rows = select(reply.rows, args);
    console.log(`[goldens] reply: ${rows.length} row(s), ${layerLabel}, out=${path.relative(process.cwd(), outDir)}`);
    const run = await runReplies(env, args, rows, openai);
    const baseline = baselineFile ? loadBaseline(baselineFile) : null;
    const diffable = run.results.map((r) => ({ id: r.id, correct: r.passed }));
    const diff = baseline ? diffRows(baseline, diffable, path.relative(process.cwd(), baselineFile as string)) : null;
    const md = formatReplyMarkdown(run.results, { costUsd: run.costUsd, diff, total: reply.rows.length });
    const json = {
      set: 'reply',
      layer: layerLabel,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitSha: gitSha(),
      totalRowsInSet: reply.rows.length,
      stopped: run.stopped,
      cost: {
        recordedUsd: Number(run.costUsd.toFixed(6)),
        classifierUsd: Number(run.classifierUsd.toFixed(6)),
        appCalls: run.cost.calls,
        callsWithoutTokenCounts: run.cost.unrecordedCalls,
        byPurpose: run.cost.byPurpose,
        note: 'Recorded = token counts from session_llm_usage (chat replies, in-session assessor and checks) plus the classifier calls the API reported, priced at src/redteam/config.ts rates.',
      },
      summary: {
        rows: run.results.length,
        reviewed: run.results.filter((r) => r.reviewed).length,
        passed: run.results.filter((r) => r.passed).length,
        deterministicPassed: run.results.filter((r) => r.deterministicPassed).length,
        errored: run.results.filter((r) => r.error).length,
        knownGaps: {
          failingAsExpected: run.results.filter((r) => r.knownGap && !r.passed).map((r) => r.id),
          nowPassing: run.results.filter((r) => r.knownGap && r.passed).map((r) => r.id),
        },
        newFailures: run.results.filter((r) => !r.knownGap && !r.passed).map((r) => r.id),
      },
      diff,
      rows: run.results.map((r) => ({ ...r, correct: r.passed })),
    };
    fs.writeFileSync(summaryPath, JSON.stringify(json, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'report.md'), md);
    console.log('\n' + md);
    if (run.stopped) {
      console.error(`[goldens] STOPPED: ${run.stopped}`);
      code = 3;
    }
  }
  console.log(`[goldens] wrote ${path.relative(process.cwd(), summaryPath)} and report.md`);
  // Goldens report rates; they do not gate. Exit non-zero only when the run
  // itself could not finish.
  await flushAndExit(code);
}

main().catch(async (err) => {
  console.error('[goldens] fatal:', err);
  await flushAndExit(1);
});
