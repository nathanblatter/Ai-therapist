// Offline evaluation of three Decisions API questions for the crisis pipeline
// (docs/decisions-crisis-classifiers-2026-11-26.md):
//
//   answer    what a reply to a safety question says (choice: yes / no / unclear)
//             rows: evals/goldens/safety-answer.jsonl
//   subject   whose risk a message is about (choice: own / third_party /
//             harm_to_others / none)
//             rows: evals/goldens/risk-subject.jsonl, plus the detector goldens
//             with a label DERIVED from each row's category and band
//   language  is the message wholly or partly not English (predicate), beside
//             the deterministic screen (server/services/nonEnglishScreen.ts)
//             rows: evals/goldens/detector-language.jsonl, plus every row of
//             the other three files as English controls
//
//   npm run redteam:decisions-eval -- --confirm-paid
//   npm run redteam:decisions-eval -- --confirm-paid --repeat 2 --out <dir>
//   npm run redteam:decisions-eval -- --dry-run     (no calls; the free screen only)
//
// OPT-IN AND PAID (about 770 small Decisions requests per repeat). Never run
// in CI; refuses to start without --confirm-paid. It prints token counts, not
// dollars: read spend from the OpenAI costs API.
//
// No database, no server boot, nothing paged. Each request is one question
// with the same wording and the same input text the shadow scorer sends
// (shadowRiskQuestions.ts), so what is measured here is what runs there.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import {
  DETECTOR_FILE,
  DETECTOR_LANGUAGE_FILE,
  REPO_ROOT,
  RISK_SUBJECT_FILE,
  SAFETY_ANSWER_FILE,
  loadDetectorGoldens,
} from './load.js';
import type { DetectorRow, RiskSubject } from './schema.js';
import {
  buildShadowInput,
  nonEnglishQuestion,
  riskSubjectQuestion,
  safetyAnswerQuestion,
  SHADOW_MODEL,
  type ShadowHistoryTurn,
} from '../../server/services/shadowRiskQuestions.js';
import { detectNonEnglish } from '../../server/services/nonEnglishScreen.js';

type Task = 'answer' | 'subject' | 'language';

interface Args {
  confirmPaid: boolean;
  dryRun: boolean;
  repeat: number;
  concurrency: number;
  out: string;
  tasks: Task[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    confirmPaid: false,
    dryRun: false,
    repeat: 1,
    concurrency: 6,
    out: path.join(REPO_ROOT, 'redteam-results', 'decisions-eval'),
    tasks: ['answer', 'subject', 'language'],
  };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] ?? '';
    switch (argv[i]) {
      case '--confirm-paid':
        a.confirmPaid = true;
        break;
      case '--dry-run':
        a.dryRun = true;
        break;
      case '--repeat':
        a.repeat = Math.max(1, Number(next()) || 1);
        break;
      case '--concurrency':
        a.concurrency = Math.max(1, Number(next()) || 1);
        break;
      case '--out':
        a.out = path.resolve(next());
        break;
      case '--tasks':
        a.tasks = next()
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is Task => t === 'answer' || t === 'subject' || t === 'language');
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return a;
}

/** The subject a detector-goldens row implies, or null where its category and
 *  band do not settle it (the low band: distress with nobody clearly at risk). */
export function derivedSubject(row: Pick<DetectorRow, 'category' | 'expected'>): RiskSubject | null {
  const band = row.expected.band;
  if (row.expected.subject) return row.expected.subject;
  if (band === 'none') return 'none';
  if (row.category === 'harm-to-others') return 'harm_to_others';
  if (band === 'low') return null;
  return row.category === 'bystander-report' ? 'third_party' : 'own';
}

interface Job {
  task: Task;
  file: string;
  row: DetectorRow;
  expected: string | null;
}

export interface EvalAnswer {
  /** The chosen value (choice) or 'yes' / 'no' at 0.5 (predicate). null: refused or failed. */
  value: string | null;
  /** Probability per value (choice) or { yes } (predicate). */
  probabilities: Record<string, number> | null;
  refused: boolean;
  error: string | null;
  latencyMs: number;
  tokensIn: number | null;
}

export interface EvalRow {
  task: Task;
  file: string;
  id: string;
  input: string;
  category: string;
  language: string;
  expected: string | null;
  expectedBand: string;
  /** The deterministic screen's answer for this input (language task). */
  screen?: { nonEnglish: boolean; signals: string[] };
  answers: EvalAnswer[];
}

function historyOf(row: DetectorRow): ShadowHistoryTurn[] {
  return row.history.map((t) => ({ role: t.role, content: t.text }));
}

function questionFor(task: Task) {
  return task === 'answer' ? safetyAnswerQuestion() : task === 'subject' ? riskSubjectQuestion() : nonEnglishQuestion();
}

async function ask(client: OpenAI, job: Job): Promise<EvalAnswer> {
  const started = Date.now();
  try {
    const raw = (await client.decisions.create({
      model: SHADOW_MODEL,
      input: buildShadowInput(job.row.input, historyOf(job.row)),
      questions: [questionFor(job.task)],
    })) as unknown as { answers?: Array<Record<string, unknown>>; usage?: { input_tokens?: number } };
    const latencyMs = Date.now() - started;
    const answer = raw.answers?.[0];
    const tokensIn = raw.usage?.input_tokens ?? null;
    if (!answer) return { value: null, probabilities: null, refused: false, error: 'no answer', latencyMs, tokensIn };
    if (answer.type === 'refusal') {
      return { value: null, probabilities: null, refused: true, error: null, latencyMs, tokensIn };
    }
    if (answer.type === 'predicate' && typeof answer.probability === 'number') {
      const p = answer.probability;
      return {
        value: p >= 0.5 ? 'yes' : 'no',
        probabilities: { yes: p },
        refused: false,
        error: null,
        latencyMs,
        tokensIn,
      };
    }
    if (answer.type === 'choice' && Array.isArray(answer.probabilities)) {
      const probabilities: Record<string, number> = {};
      for (const p of answer.probabilities as Array<{ value: unknown; probability: unknown }>) {
        probabilities[String(p.value)] = Number(p.probability);
      }
      return { value: String(answer.choice), probabilities, refused: false, error: null, latencyMs, tokensIn };
    }
    return { value: null, probabilities: null, refused: false, error: 'malformed', latencyMs, tokensIn };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return {
      value: null,
      probabilities: null,
      refused: false,
      error: typeof status === 'number' ? `http_${status}` : ((err as Error).name ?? 'error'),
      latencyMs: Date.now() - started,
      tokensIn: null,
    };
  }
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export interface TaskSummary {
  rows: number;
  /** Rows with a label (the detector goldens' low band has none for subject). */
  labelled: number;
  calls: number;
  refusedCalls: number;
  refusedIds: string[];
  erroredCalls: number;
  /** Labelled rows whose first answer matched the label. */
  correct: number;
  /** Rows whose answers differed between repeats. */
  unstable: string[];
  /** confusion[expected][answered]; "none given" for a refusal or error. */
  confusion: Record<string, Record<string, number>>;
  wrong: Array<{ id: string; expected: string; got: string | null; input: string }>;
  latencyMs: { p50: number; p95: number; max: number };
  meanTokensIn: number;
}

export function summarize(rows: EvalRow[]): TaskSummary {
  const confusion: Record<string, Record<string, number>> = {};
  const wrong: TaskSummary['wrong'] = [];
  const refusedIds: string[] = [];
  const unstable: string[] = [];
  let correct = 0;
  let labelled = 0;
  let refusedCalls = 0;
  let erroredCalls = 0;
  const latencies: number[] = [];
  let tokens = 0;
  let tokenCalls = 0;
  for (const r of rows) {
    for (const a of r.answers) {
      latencies.push(a.latencyMs);
      if (a.refused) refusedCalls++;
      if (a.error) erroredCalls++;
      if (a.tokensIn !== null) {
        tokens += a.tokensIn;
        tokenCalls++;
      }
    }
    if (r.answers.some((a) => a.refused)) refusedIds.push(r.id);
    if (new Set(r.answers.map((a) => a.value)).size > 1) unstable.push(r.id);
    if (r.expected === null) continue;
    labelled++;
    const got = r.answers[0]?.value ?? null;
    (confusion[r.expected] ??= {})[got ?? 'none given'] ??= 0;
    confusion[r.expected][got ?? 'none given']++;
    if (got === r.expected) correct++;
    else wrong.push({ id: r.id, expected: r.expected, got, input: r.input });
  }
  latencies.sort((x, y) => x - y);
  return {
    rows: rows.length,
    labelled,
    calls: rows.reduce((n, r) => n + r.answers.length, 0),
    refusedCalls,
    refusedIds,
    erroredCalls,
    correct,
    unstable,
    confusion,
    wrong,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? 0 },
    meanTokensIn: tokenCalls ? Math.round(tokens / tokenCalls) : 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = {
    detector: DETECTOR_FILE,
    answer: SAFETY_ANSWER_FILE,
    subject: RISK_SUBJECT_FILE,
    language: DETECTOR_LANGUAGE_FILE,
  };
  const sets = Object.fromEntries(
    Object.entries(files).map(([name, file]) => {
      const loaded = loadDetectorGoldens(file);
      if (loaded.errors.length) throw new Error(`${name}: ${loaded.errors.join('; ')}`);
      return [name, loaded.rows];
    }),
  ) as Record<keyof typeof files, DetectorRow[]>;

  const jobs: Job[] = [];
  const name = (file: string): string => path.basename(file);
  if (args.tasks.includes('answer')) {
    for (const row of sets.answer) {
      jobs.push({ task: 'answer', file: name(files.answer), row, expected: row.expected.answer ?? null });
    }
  }
  if (args.tasks.includes('subject')) {
    for (const [set, rows] of [
      ['subject', sets.subject],
      ['detector', sets.detector],
    ] as const) {
      for (const row of rows) {
        jobs.push({ task: 'subject', file: name(files[set]), row, expected: derivedSubject(row) });
      }
    }
  }
  if (args.tasks.includes('language')) {
    for (const set of ['language', 'detector', 'answer', 'subject'] as const) {
      for (const row of sets[set]) {
        const nonEnglish = (row.language ?? 'en') !== 'en';
        jobs.push({ task: 'language', file: name(files[set]), row, expected: nonEnglish ? 'yes' : 'no' });
      }
    }
  }

  console.log(
    `[decisions-eval] ${jobs.length} request(s) per repeat, repeat ${args.repeat}, model ${SHADOW_MODEL}` +
      (args.dryRun ? ' (dry run: no calls)' : ''),
  );
  if (!args.dryRun && !args.confirmPaid) {
    throw new Error('this run is paid: pass --confirm-paid (or --dry-run for the free screen only)');
  }
  const client = args.dryRun
    ? null
    : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });

  const rows: EvalRow[] = jobs.map((job) => ({
    task: job.task,
    file: job.file,
    id: job.row.id,
    input: job.row.input,
    category: job.row.category,
    language: job.row.language ?? 'en',
    expected: job.expected,
    expectedBand: job.row.expected.band,
    ...(job.task === 'language' ? { screen: detectNonEnglish(job.row.input) } : {}),
    answers: [],
  }));
  if (client) {
    for (let repeat = 0; repeat < args.repeat; repeat++) {
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          if (i >= jobs.length) return;
          rows[i].answers.push(await ask(client, jobs[i]));
        }
      };
      await Promise.all(Array.from({ length: args.concurrency }, worker));
      console.log(`[decisions-eval] repeat ${repeat + 1} of ${args.repeat} done`);
    }
  }

  const summary = Object.fromEntries(
    args.tasks.map((task) => {
      const mine = rows.filter((r) => r.task === task);
      const byFile = Object.fromEntries(
        [...new Set(mine.map((r) => r.file))].map((file) => [file, summarize(mine.filter((r) => r.file === file))]),
      );
      return [task, { all: summarize(mine), byFile }];
    }),
  );
  // The free screen on the language rows, in the same shape.
  const lang = rows.filter((r) => r.task === 'language');
  const screenWrong = lang.filter((r) => (r.screen?.nonEnglish ? 'yes' : 'no') !== r.expected);
  const screen = {
    rows: lang.length,
    nonEnglishRows: lang.filter((r) => r.expected === 'yes').length,
    nonEnglishCaught: lang.filter((r) => r.expected === 'yes' && r.screen?.nonEnglish).length,
    englishRows: lang.filter((r) => r.expected === 'no').length,
    englishFalseWakes: lang.filter((r) => r.expected === 'no' && r.screen?.nonEnglish).length,
    wrong: screenWrong.map((r) => ({ id: r.id, expected: r.expected, signals: r.screen?.signals, input: r.input })),
  };

  fs.mkdirSync(args.out, { recursive: true });
  const outFile = path.join(args.out, 'decisions-crisis-classifiers.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { model: SHADOW_MODEL, ranAt: new Date().toISOString(), repeat: args.repeat, summary, screen, rows },
      null,
      2,
    ) + '\n',
  );
  for (const [task, s] of Object.entries(summary)) {
    const a = s.all;
    console.log(
      `[decisions-eval] ${task}: ${a.correct}/${a.labelled} labelled rows right, ${a.refusedCalls} refused call(s) ` +
        `[${a.refusedIds.join(', ')}], ${a.erroredCalls} errored, ${a.unstable.length} unstable, ` +
        `p50 ${a.latencyMs.p50} ms, p95 ${a.latencyMs.p95} ms, mean ${a.meanTokensIn} input tokens`,
    );
  }
  console.log(
    `[decisions-eval] deterministic screen: ${screen.nonEnglishCaught}/${screen.nonEnglishRows} non-English rows ` +
      `caught, ${screen.englishFalseWakes}/${screen.englishRows} English rows woken`,
  );
  console.log(`[decisions-eval] wrote ${path.relative(process.cwd(), outFile)}`);
}

// Only when run as a script (the summary helpers are imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`[decisions-eval] ${(err as Error).message}`);
    process.exit(1);
  });
}
