// Agreement between the two yes/no judges (yesNoJudge.ts) on the same
// (question, text) pairs. Run it before moving a rubric's default judge, and
// again after rewording a question (docs/redteam.md, "Yes/no judges").
//
//   OPENAI_API_KEY=... npm run redteam:judge-agreement -- \
//     [--results <summary.json | dir> ...] [--origin <set> ...] [--repeats 2] [--limit n] [--out <file.json>]
//
// `--origin` keeps only the named fixture sets (protocol, catalogue, scope,
// memory, crisis, boundary, grounding, tone) or scenario ids, to re-measure
// one rubric family after rewording it.
//
// Material, none of it generated here:
//   - the labelled rubric fixtures (protocol, catalogue, scope, memory, crisis,
//     boundary, grounding): synthetic replies with the verdict each must get;
//   - `--results`: summary.json files of earlier harness runs (a CI artifact).
//     The assertions a judge answered in that run (their detail carries the
//     vote count) are replayed over the recorded transcript with a recording
//     judge and no database, to recover the questions the run asked about real
//     model replies. Those pairs carry no label. Nothing else is replayed:
//     some "assertions" are probes that act on the server.
//
// Every pair is then put to both judges `--repeats` times. Nothing is written
// to a database and no scenario is run: the only spend is the judging itself.
import fs from 'node:fs';
import path from 'node:path';

import type { AssertionContext, AssertionSpec, ClassifyRequest, Scenario, Turn } from './types.js';

export interface JudgePair {
  source: 'fixture' | 'run';
  /** Fixture set, or the scenario id the pair was recovered from. */
  origin: string;
  assertionId: string;
  name: string;
  version: string;
  question: string;
  text: string;
  votes: number;
  /** The verdict the fixture requires; null when unlabelled. */
  expected: boolean | null;
}

export interface LlmAnswer {
  verdict: boolean;
  /** YES votes of `votes`. */
  yes: number;
}
export type DecisionsOutcome = { probability: number } | { unknown: string };

export interface JudgedPair extends JudgePair {
  llm: LlmAnswer[];
  decisions: DecisionsOutcome[];
}

/** No database, no paging: called before any app module is loaded (the
 *  collectors import them lazily). A replayed assertion that reaches for the
 *  database must fail, not connect to one. */
function isolateFromApp(): void {
  process.env.DATABASE_URL = 'postgresql://judge-agreement:unused@127.0.0.1:1/unused';
  process.env.IMESSAGE_API_KEY = '';
  process.env.CRISIS_ALERT_PHONE = '';
  process.env.CRISIS_SMS_AWS_REGION = '';
  process.env.CRISIS_SMS_ORIGINATION_IDENTITY = '';
  process.env.SOCKET_PG_ADAPTER = 'off';
  process.env.NODE_ENV = 'test';
}

const key = (r: Pick<ClassifyRequest, 'version' | 'question' | 'text'>) =>
  `${r.version}\u0000${r.question}\u0000${r.text}`;

const baseCtx = (transcript: Turn[], latestReply: string): Omit<AssertionContext, 'classify'> => ({
  scenarioId: 'judge-agreement',
  sessionId: 'judge-agreement',
  latestReply,
  transcript,
  emissions: [],
  beatPostTimes: {},
  systemPromptCanaries: [],
  pool: { query: async () => ({ rows: [] }) },
  dryRun: false,
});

/** Run an assertion with a judge that answers `verdict` to everything and
 *  records what it was asked. A throw (the assertion wanted a database) is an
 *  empty recording. */
async function record(
  spec: AssertionSpec,
  ctx: Omit<AssertionContext, 'classify'>,
  verdict: boolean,
): Promise<{ passed: boolean | null; asked: ClassifyRequest[] }> {
  const asked: ClassifyRequest[] = [];
  try {
    const run = spec.run({
      ...ctx,
      classify: async (req) => {
        asked.push(req);
        return { verdict, evidence: 'recording' };
      },
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('assertion did not settle offline')), 5000);
    });
    const r = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    return { passed: r.passed, asked };
  } catch {
    return { passed: null, asked };
  }
}

/**
 * The questions an assertion asks about this context, and, when the fixture
 * says whether the assertion must pass, the verdict that makes it so. The
 * label is set only when one question decides the outcome on its own.
 */
export async function pairsFor(
  spec: AssertionSpec,
  ctx: Omit<AssertionContext, 'classify'>,
  meta: Pick<JudgePair, 'source' | 'origin' | 'name'>,
  expectPass: boolean | null,
): Promise<JudgePair[]> {
  const no = await record(spec, ctx, false);
  const yes = await record(spec, ctx, true);
  const asked = new Map<string, ClassifyRequest>();
  for (const req of [...no.asked, ...yes.asked]) asked.set(key(req), req);
  const decisive = asked.size === 1 && no.passed !== null && yes.passed !== null && no.passed !== yes.passed;
  return [...asked.values()].map((req) => ({
    ...meta,
    assertionId: spec.id,
    version: req.version,
    question: req.question,
    text: req.text,
    votes: req.votes ?? 1,
    expected: decisive && expectPass !== null ? yes.passed === expectPass : null,
  }));
}

export async function collectFixturePairs(): Promise<JudgePair[]> {
  isolateFromApp();
  const { RUBRIC_FIXTURES } = await import('./protocolRubricFixtures.js');
  const { CATALOGUE_FIXTURES } = await import('./catalogueRubricFixtures.js');
  const { SCOPE_RUBRIC_FIXTURES } = await import('./scopeRubricFixtures.js');
  const { MEMORY_RUBRIC_FIXTURES } = await import('./memoryFixtures.js');
  const { CRISIS_RUBRIC_CASES } = await import('./crisisRubricCases.js');
  const { BOUNDARY_FIXTURES, GROUNDING_FIXTURES, TONE_FIXTURES } = await import('./graderFixtures.js');
  const { GROUNDING_RUBRIC, HOLDS_BOUNDARY_RUBRICS, noHarshConfrontation, normalizeQuotes, warmNonShaming } =
    await import('./assertions.js');
  const { warmUnderPushback } = await import('./relationalAssertions.js');
  const { A } = await import('./crisisTestSupport.js');

  const out: JudgePair[] = [];
  const sets = {
    protocol: RUBRIC_FIXTURES,
    catalogue: CATALOGUE_FIXTURES,
    scope: SCOPE_RUBRIC_FIXTURES,
    memory: MEMORY_RUBRIC_FIXTURES,
  };
  for (const [origin, fixtures] of Object.entries(sets)) {
    for (const fx of fixtures) {
      const meta = { source: 'fixture' as const, origin, name: fx.name };
      out.push(...(await pairsFor(fx.assertion(), baseCtx([], fx.reply), meta, fx.expectPass)));
    }
  }
  for (const c of CRISIS_RUBRIC_CASES) {
    for (const [label, reply, expectPass] of [
      ['good', c.good, true],
      ['bad', c.bad, false],
    ] as const) {
      const meta = { source: 'fixture' as const, origin: 'crisis', name: `${c.name}: ${label}` };
      out.push(...(await pairsFor(c.spec, baseCtx([...c.before, A(reply)], reply), meta, expectPass)));
    }
  }
  const toneGraders = {
    'warm-non-shaming': warmNonShaming,
    'no-harsh-confrontation': noHarshConfrontation,
    'warm-under-pushback': warmUnderPushback,
  };
  for (const f of TONE_FIXTURES) {
    const ctx = baseCtx([{ role: 'user', text: f.participant }, A(f.reply)], f.reply);
    const meta = { source: 'fixture' as const, origin: 'tone', name: f.name };
    out.push(...(await pairsFor(toneGraders[f.grader](), ctx, meta, f.expectPass)));
  }
  // These two sets are graded on the bare rubric question, as their own
  // calibration test does (graderCalibration.test.ts).
  for (const f of BOUNDARY_FIXTURES) {
    out.push({
      source: 'fixture',
      origin: 'boundary',
      assertionId: `holds-boundary:${f.kind}`,
      name: f.name,
      ...HOLDS_BOUNDARY_RUBRICS[f.kind],
      text: normalizeQuotes(f.reply),
      votes: 3,
      expected: f.held,
    });
  }
  for (const f of GROUNDING_FIXTURES) {
    out.push({
      source: 'fixture',
      origin: 'grounding',
      assertionId: 'grounding-present',
      name: f.name,
      ...GROUNDING_RUBRIC,
      text: normalizeQuotes(f.reply),
      votes: 3,
      expected: f.grounded,
    });
  }
  return out;
}

interface RecordedScenario {
  id: string;
  pipeline?: string;
  transcript?: Turn[];
  assertions?: Array<{ id: string; detail?: string }>;
}

/** What a judge's answer looks like in a recorded detail: the LLM judge's
 *  vote count, or the Decisions judge's probability. */
const JUDGED_DETAIL = /\[\d+\/\d+ yes\]|\[decisions /;

/** Ids of the recorded assertions a judge answered. */
export function judgedAssertionIds(recorded: RecordedScenario): Set<string> {
  return new Set((recorded.assertions ?? []).filter((a) => JUDGED_DETAIL.test(a.detail ?? '')).map((a) => a.id));
}

/** Replay one recorded scenario's assertions over its transcript, as the
 *  runner would have built each context, to recover what the judge was asked. */
export async function pairsFromRecordedScenario(scenario: Scenario, recorded: RecordedScenario): Promise<JudgePair[]> {
  const transcript = recorded.transcript ?? [];
  if (scenario.sessions || transcript.length === 0) return [];
  const judged = judgedAssertionIds(recorded);
  const out: JudgePair[] = [];
  const meta = { source: 'run' as const, origin: scenario.id };
  for (const beat of scenario.beats) {
    if (!beat.assertAfter?.some((spec) => judged.has(spec.id))) continue;
    const last = transcript.map((t) => t.beatId).lastIndexOf(beat.id);
    if (last < 0) continue;
    const upTo = transcript.slice(0, last + 1);
    const lastReply = [...upTo].reverse().find((t) => t.role === 'assistant')?.text ?? '';
    const reply = scenario.pipeline === 'realtime-text' ? '' : lastReply;
    for (const spec of beat.assertAfter) {
      if (!judged.has(spec.id)) continue;
      out.push(
        ...(await pairsFor(spec, { ...baseCtx(upTo, reply), beatId: beat.id }, { ...meta, name: beat.id }, null)),
      );
    }
  }
  for (const spec of scenario.assertFinal ?? []) {
    if (!judged.has(spec.id)) continue;
    out.push(...(await pairsFor(spec, baseCtx(transcript, ''), { ...meta, name: 'final' }, null)));
  }
  return out;
}

export async function collectRunPairs(summaryPaths: string[]): Promise<JudgePair[]> {
  isolateFromApp();
  const idx = await import('./scenarios/index.js');
  const byId = new Map<string, Scenario>();
  for (const s of [...idx.ALL_SCENARIOS, ...idx.EXTENDED_SCENARIOS, ...idx.SMOKE_SUITE.map((e) => e.scenario)]) {
    byId.set(s.id, s);
  }
  const out: JudgePair[] = [];
  for (const p of summaryPaths) {
    const file = fs.statSync(p).isDirectory() ? path.join(p, 'summary.json') : p;
    const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios?: RecordedScenario[] };
    for (const recorded of summary.scenarios ?? []) {
      const scenario = byId.get(recorded.id.replace(/#v\d+$/, ''));
      if (scenario) out.push(...(await pairsFromRecordedScenario(scenario, recorded)));
    }
  }
  return out;
}

export function dedupePairs(pairs: JudgePair[]): JudgePair[] {
  const seen = new Map<string, JudgePair>();
  for (const p of pairs) {
    const k = key(p);
    const prior = seen.get(k);
    // Keep the labelled copy when the same pair shows up twice.
    if (!prior || (prior.expected === null && p.expected !== null)) seen.set(k, p);
  }
  return [...seen.values()];
}

export interface RubricAgreement {
  version: string;
  n: number;
  /** Pairs where Decisions gave a definite answer on every repeat. */
  definite: number;
  refused: number;
  unsure: number;
  errors: number;
  /** Of `definite`: same verdict as the LLM judge's first answer. */
  agree: number;
  labelled: number;
  llmRight: number;
  /** Of the labelled pairs with a definite Decisions answer. */
  decisionsLabelled: number;
  decisionsRight: number;
  /** Pairs whose LLM verdict differed between repeats. */
  llmFlips: number;
  /** Pairs whose Decisions verdict (or its definiteness) differed between repeats. */
  decisionsFlips: number;
}

type Reading = { kind: 'definite'; verdict: boolean } | { kind: 'refused' | 'unsure' | 'error' };

export function readDecisions(o: DecisionsOutcome, isUnsure: (p: number) => boolean): Reading {
  if ('unknown' in o) return { kind: o.unknown === 'refused' ? 'refused' : 'error' };
  return isUnsure(o.probability) ? { kind: 'unsure' } : { kind: 'definite', verdict: o.probability >= 0.5 };
}

/** Per rubric version. Pure, so the table can be recomputed from a saved file
 *  with a different unsure band. */
export function summarise(rows: JudgedPair[], isUnsure: (p: number) => boolean): RubricAgreement[] {
  const by = new Map<string, RubricAgreement>();
  for (const r of rows) {
    if (r.llm.length === 0 || r.decisions.length === 0) continue;
    let a = by.get(r.version);
    if (!a) {
      a = {
        version: r.version,
        n: 0,
        definite: 0,
        refused: 0,
        unsure: 0,
        errors: 0,
        agree: 0,
        labelled: 0,
        llmRight: 0,
        decisionsLabelled: 0,
        decisionsRight: 0,
        llmFlips: 0,
        decisionsFlips: 0,
      };
      by.set(r.version, a);
    }
    a.n += 1;
    const llm = r.llm[0].verdict;
    const readings = r.decisions.map((o) => readDecisions(o, isUnsure));
    const first = readings[0];
    if (r.llm.some((x) => x.verdict !== llm)) a.llmFlips += 1;
    if (readings.some((x) => JSON.stringify(x) !== JSON.stringify(first))) a.decisionsFlips += 1;
    if (r.expected !== null) {
      a.labelled += 1;
      if (llm === r.expected) a.llmRight += 1;
    }
    if (first.kind !== 'definite') {
      if (first.kind === 'refused') a.refused += 1;
      else if (first.kind === 'unsure') a.unsure += 1;
      else a.errors += 1;
    } else {
      a.definite += 1;
      if (first.verdict === llm) a.agree += 1;
      if (r.expected !== null) {
        a.decisionsLabelled += 1;
        if (first.verdict === r.expected) a.decisionsRight += 1;
      }
    }
  }
  return [...by.values()].sort((x, y) => x.version.localeCompare(y.version));
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const results: string[] = [];
  const origins: string[] = [];
  let repeats = 2;
  let limit = Infinity;
  let outFile = path.join('redteam-results', 'judge-agreement.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--results') results.push(argv[++i]);
    else if (argv[i] === '--origin') origins.push(argv[++i]);
    else if (argv[i] === '--repeats') repeats = Math.max(1, Number(argv[++i]) || 2);
    else if (argv[i] === '--limit') limit = Math.max(1, Number(argv[++i]) || Infinity);
    else if (argv[i] === '--out') outFile = argv[++i];
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY must be set');

  const pairs = dedupePairs([...(await collectFixturePairs()), ...(await collectRunPairs(results))])
    .filter((p) => origins.length === 0 || origins.includes(p.origin))
    .slice(0, limit);
  console.log(
    `[judge-agreement] ${pairs.length} distinct pairs (${pairs.filter((p) => p.source === 'fixture').length} fixture, ` +
      `${pairs.filter((p) => p.source === 'run').length} from recorded runs), ${repeats} repeats per judge`,
  );

  const OpenAI = (await import('openai')).default;
  const { makeClassifier } = await import('./assertions.js');
  const { CostTracker, DEFAULTS } = await import('./config.js');
  const { askDecisionsJudge, DecisionsJudgeUnknown, isUnsure } = await import('./yesNoJudge.js');
  const client = new OpenAI({ apiKey });
  const cost = new CostTracker();
  const llm = makeClassifier(client, { ...DEFAULTS, yesNoJudge: 'llm' }, cost);

  const judged = await mapPool(pairs, 8, async (pair, i): Promise<JudgedPair> => {
    const row: JudgedPair = { ...pair, llm: [], decisions: [] };
    for (let k = 0; k < repeats; k++) {
      try {
        const r = await llm(pair);
        const m = /^\[(\d+)\/\d+ yes\]/.exec(r.evidence);
        row.llm.push({ verdict: r.verdict, yes: m ? Number(m[1]) : r.verdict ? 1 : 0 });
      } catch (err) {
        console.warn(`[judge-agreement] LLM judge failed on ${pair.version}: ${(err as Error).message.slice(0, 100)}`);
      }
      try {
        row.decisions.push({ probability: (await askDecisionsJudge(client, pair)).probability });
      } catch (err) {
        const reason = err instanceof DecisionsJudgeUnknown ? err.reason : `error: ${(err as Error).message}`;
        row.decisions.push({ unknown: reason.slice(0, 160) });
      }
    }
    if ((i + 1) % 50 === 0) console.log(`[judge-agreement] ${i + 1}/${pairs.length}`);
    return row;
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ judgedAt: new Date().toISOString(), repeats, pairs: judged }, null, 2));

  const table = summarise(judged, isUnsure);
  console.log('rubric | n | definite | agree | refused | unsure | errors | labelled | LLM right | Decisions right');
  for (const a of table) {
    console.log(
      `${a.version} | ${a.n} | ${a.definite} | ${a.agree} | ${a.refused} | ${a.unsure} | ${a.errors} | ` +
        `${a.labelled} | ${a.llmRight} | ${a.decisionsRight}/${a.decisionsLabelled}`,
    );
  }
  console.log(`[judge-agreement] wrote ${outFile}`);
  console.log(`[judge-agreement] LLM judge calls priced from the harness table: $${cost.usd.toFixed(4)} (not billing)`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  // Exit explicitly: the app modules the fixtures import keep handles open.
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
