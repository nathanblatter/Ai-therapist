// Offline evaluation of the shadow risk scorer (ai-therapist-83,
// ai-therapist-261): ask the scorer's question set (the same request the live
// scorer sends, server/services/shadowRiskQuestions.ts) about every row of the
// detector goldens, and compare its severity with the row's expected band and
// with what the production detector did on the same row.
//
//   npm run redteam:shadow-eval -- --confirm-paid
//   npm run redteam:shadow-eval -- --confirm-paid --repeat 3 --out <dir>
//   npm run redteam:shadow-eval -- --dry-run          (no calls; prints the plan)
//
// OPT-IN AND PAID. One Decisions API request per row per repeat (273 rows
// today). It is never run in CI and refuses to start without --confirm-paid.
// It prints token counts, not dollars: read spend from the OpenAI costs API.
//
// The production side is NOT re-run. It is read from the committed baseline
// (evals/goldens/baselines/detector-full-after-fixes.json by default), after
// checking that every baseline row still has the same id, input and expected
// band as the goldens file.
//
// No database, no server boot, nothing paged: this process only calls
// POST /v1/decisions with synthetic golden text. The scorer sees what the
// live one would be given: the row's check-in (when it has one), its history
// and the input. It does not see the production pipeline's session risk
// context line, because the live scorer does not either.
//
// Flags: --confirm-paid  --dry-run  --repeat n (default 1)  --concurrency n (default 6)
//        --ids a,b  --category c  --limit n  --out <dir>  --baseline <file.json>
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { loadDetectorGoldens, GOLDENS_DIR, REPO_ROOT } from './load.js';
import { BANDS, type Band, type DetectorRow } from './schema.js';
import {
  buildShadowBody,
  parseShadowResponse,
  SHADOW_MODEL,
  SHADOW_QUESTION_SET_VERSION,
  type ShadowHistoryTurn,
} from '../../server/services/shadowRiskQuestions.js';
import {
  formatShadowEvalMarkdown,
  scoreShadowRows,
  summarizeShadowEval,
  type ProductionBaselineRow,
  type ShadowEvalAnswer,
} from './shadowEvalReport.js';

interface Args {
  confirmPaid: boolean;
  dryRun: boolean;
  repeat: number;
  concurrency: number;
  ids?: string[];
  category?: string;
  limit?: number;
  out: string;
  baseline: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    confirmPaid: false,
    dryRun: false,
    repeat: 1,
    concurrency: 6,
    out: path.join(REPO_ROOT, 'redteam-results', 'shadow-eval'),
    baseline: path.join(GOLDENS_DIR, 'baselines', 'detector-full-after-fixes.json'),
  };
  const positive = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} needs a positive whole number (got ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string | undefined => argv[++i];
    switch (argv[i]) {
      case '--confirm-paid':
        a.confirmPaid = true;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--repeat':
        a.repeat = positive('--repeat', next());
        break;
      case '--concurrency':
        a.concurrency = positive('--concurrency', next());
        break;
      case '--limit':
        a.limit = positive('--limit', next());
        break;
      case '--ids':
        a.ids = (next() ?? '').split(',').filter(Boolean);
        break;
      case '--category':
        a.category = next();
        break;
      case '--out':
        a.out = path.resolve(next() ?? '');
        break;
      case '--baseline':
        a.baseline = path.resolve(next() ?? '');
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return a;
}

/** The pipeline's `medium` is the goldens' `moderate`. */
const toBand = (severity: string): Band => (severity === 'medium' ? 'moderate' : (severity as Band));

/** What the live scorer would be given for this row: the check-in line the
 *  pipeline puts before the history (withCheckinContext), then the history. */
export function historyForRow(row: DetectorRow): ShadowHistoryTurn[] {
  if (row.inputVia === 'checkin') return [];
  const checkin = [row.checkin?.topic, row.checkin?.goal].filter(Boolean).join(' ');
  return [
    ...(checkin ? [{ role: 'user', content: `[Written in the pre-session check-in form] ${checkin}` }] : []),
    ...row.history.map((t) => ({ role: t.role, content: t.text })),
  ];
}

/** Read the production baseline, refusing one that no longer matches the goldens. */
function loadBaseline(file: string, rows: DetectorRow[]): Map<string, ProductionBaselineRow> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    rows?: Array<{ id: string; input: string; expectedBand: string; observedBand: Band | null; paged: boolean }>;
  };
  const byId = new Map((raw.rows ?? []).map((r) => [r.id, r]));
  const stale = rows.filter((r) => {
    const b = byId.get(r.id);
    return !b || b.input !== r.input || b.expectedBand !== r.expected.band;
  });
  if (stale.length > 0) {
    throw new Error(
      `baseline ${path.relative(REPO_ROOT, file)} does not match the goldens for ${stale.length} row(s) ` +
        `(${stale
          .slice(0, 5)
          .map((r) => r.id)
          .join(', ')}...): re-run the detector baseline first`,
    );
  }
  return new Map(
    [...byId.values()].map((r) => [r.id, { id: r.id, observedBand: r.observedBand, paged: r.paged === true }]),
  );
}

async function askOnce(client: OpenAI, row: DetectorRow): Promise<ShadowEvalAnswer> {
  const started = Date.now();
  try {
    const raw = await client.decisions.create(buildShadowBody(row.input, historyForRow(row)));
    const answer = parseShadowResponse(raw);
    const p = answer.severityProbabilities;
    const refused = answer.refused.length > 0;
    // A refusal on any question is "no answer" here, as it is live (the row is
    // stored as errored). What did come back is kept beside it.
    return {
      id: row.id,
      band: refused || !answer.severity ? null : toBand(answer.severity),
      severityProbabilities: refused || !p ? null : { none: p.none, low: p.low, moderate: p.medium, high: p.high },
      predicates: refused ? null : answer.predicates,
      latencyMs: Date.now() - started,
      tokensIn: answer.tokensIn,
      ...(refused
        ? {
            error: `refused: ${answer.refused.join(', ')}`,
            refused: answer.refused,
            partialBand: answer.severity ? toBand(answer.severity) : null,
          }
        : {}),
    };
  } catch (err) {
    return {
      id: row.id,
      band: null,
      severityProbabilities: null,
      predicates: null,
      latencyMs: Date.now() - started,
      tokensIn: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadDetectorGoldens();
  if (loaded.errors.length > 0) throw new Error(`goldens do not validate:\n${loaded.errors.join('\n')}`);
  let rows = loaded.rows;
  if (args.ids) rows = rows.filter((r) => args.ids?.includes(r.id));
  if (args.category) rows = rows.filter((r) => r.category === args.category);
  if (args.limit) rows = rows.slice(0, args.limit);
  const production = loadBaseline(args.baseline, rows);
  const calls = rows.length * args.repeat;
  console.log(
    `[shadow-eval] ${rows.length} row(s) x ${args.repeat} repeat(s) = ${calls} Decisions API call(s) on ${SHADOW_MODEL}`,
  );
  if (args.dryRun) {
    console.log('[shadow-eval] --dry-run: nothing sent. First request body:');
    console.log(JSON.stringify(buildShadowBody(rows[0].input, historyForRow(rows[0])), null, 2));
    return;
  }
  if (!args.confirmPaid) {
    throw new Error('this run makes paid OpenAI calls: pass --confirm-paid (or --dry-run to see the plan)');
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 2 });

  const startedAt = new Date().toISOString();
  // runs[k] holds every row's answer on repeat k. The report is on repeat 0;
  // the later repeats only measure how stable the answer is.
  const runs: ShadowEvalAnswer[][] = [];
  for (let k = 0; k < args.repeat; k++) {
    const answers: ShadowEvalAnswer[] = new Array(rows.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < rows.length) {
        const i = next++;
        answers[i] = await askOnce(client, rows[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(args.concurrency, rows.length) }, worker));
    runs.push(answers);
    console.log(`[shadow-eval] repeat ${k + 1}/${args.repeat}: ${answers.filter((a) => a.band).length} answered`);
  }
  const finishedAt = new Date().toISOString();

  const first = new Map(runs[0].map((a) => [a.id, a]));
  const scored = scoreShadowRows(rows, first, production);
  const summary = summarizeShadowEval(scored, first, true);

  // Stability across repeats: rows whose band differs between any two runs,
  // and the largest swing in P(high).
  const unstable: Array<{ id: string; bands: Array<Band | null>; pHigh: Array<number | null> }> = [];
  let maxSwing = 0;
  rows.forEach((row, i) => {
    const bands = runs.map((r) => r[i].band);
    const pHigh = runs.map((r) => r[i].severityProbabilities?.high ?? null);
    const known = pHigh.filter((p): p is number => p !== null);
    if (known.length > 1) maxSwing = Math.max(maxSwing, Math.max(...known) - Math.min(...known));
    if (new Set(bands).size > 1) unstable.push({ id: row.id, bands, pHigh });
  });

  // A page line on P(high) instead of the most likely band.
  const sweep = [0.5, 0.3, 0.2, 0.1].map((t) => {
    const at = (r: (typeof scored)[number]): boolean => r.shadowPHigh !== null && r.shadowPHigh >= t;
    const must = scored.filter((r) => r.expectedPage === 'yes');
    const mustNot = scored.filter(
      (r) => r.expectedPage === 'no' && (r.expectedBand === 'none' || r.expectedBand === 'low'),
    );
    return {
      threshold: t,
      mustPageHit: must.filter(at).length,
      mustPageN: must.length,
      mustNotPageHit: mustNot.filter(at).length,
      mustNotPageN: mustNot.length,
    };
  });

  const all = runs.flat();
  const latencies = all
    .map((a) => a.latencyMs)
    .filter((x): x is number => x !== null)
    .sort((x, y) => x - y);
  const quantile = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
  const tokensIn = all.reduce((s, a) => s + (a.tokensIn ?? 0), 0);
  const usage = {
    calls: all.length,
    errored: all.filter((a) => a.band === null).length,
    tokensIn,
    meanTokensInPerCall: Math.round(tokensIn / Math.max(1, all.filter((a) => a.tokensIn !== null).length)),
    latencyMsP50: quantile(0.5),
    latencyMsP95: quantile(0.95),
  };

  const refusals = runs[0].filter((a) => (a.refused?.length ?? 0) > 0);
  const header = [
    `Model ${SHADOW_MODEL}, question set v${SHADOW_QUESTION_SET_VERSION}, ${rows.length} rows, ` +
      `${args.repeat} repeat(s); run ${startedAt} to ${finishedAt}.`,
    `Production side: ${path.relative(REPO_ROOT, args.baseline)} (not re-run).`,
    `Calls: ${usage.calls} (${usage.errored} without an answer); input tokens ${usage.tokensIn} ` +
      `(mean ${usage.meanTokensInPerCall} per call); latency p50 ${usage.latencyMsP50} ms, p95 ${usage.latencyMsP95} ms.`,
    `Stability: ${unstable.length} row(s) changed band between repeats; largest swing in P(high) ${maxSwing.toFixed(3)}.`,
    `Refusals (a row with any refused question counts as "no answer", as it does live): ${refusals.length} row(s).`,
    ...refusals.map(
      (a) =>
        `- ${a.id}: refused ${a.refused?.join(', ')}; severity ` +
        (a.partialBand ? `still answered (${a.partialBand})` : 'not answered'),
    ),
    '',
    'Paging line on P(high) instead of the most likely band (shadow only):',
    '',
    '| P(high) at or above | "page: yes" rows reached | none/low "page: no" rows reached |',
    '|---:|---:|---:|',
    ...sweep.map((s) => `| ${s.threshold} | ${s.mustPageHit}/${s.mustPageN} | ${s.mustNotPageHit}/${s.mustNotPageN} |`),
  ];
  const markdown = formatShadowEvalMarkdown(summary, scored, header);

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'shadow-eval.md'), markdown);
  fs.writeFileSync(
    path.join(args.out, 'shadow-eval.json'),
    JSON.stringify(
      {
        set: 'detector',
        scorer: 'shadow',
        model: SHADOW_MODEL,
        questionSetVersion: SHADOW_QUESTION_SET_VERSION,
        startedAt,
        finishedAt,
        baseline: path.relative(REPO_ROOT, args.baseline),
        bands: BANDS,
        usage,
        stability: { unstable, maxSwingPHigh: Number(maxSwing.toFixed(4)) },
        thresholdSweep: sweep,
        summary,
        rows: scored.map((r) => ({
          ...r,
          severityProbabilities: first.get(r.id)?.severityProbabilities ?? null,
          predicates: first.get(r.id)?.predicates ?? null,
          error: first.get(r.id)?.error,
          refused: first.get(r.id)?.refused,
          partialBand: first.get(r.id)?.partialBand,
        })),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(markdown.split('\n').slice(0, 60).join('\n'));
  console.log(`[shadow-eval] wrote ${path.relative(REPO_ROOT, args.out)}/shadow-eval.{md,json}`);
}

main().catch((err: unknown) => {
  console.error(`[shadow-eval] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
