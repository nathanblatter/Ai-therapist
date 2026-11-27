// Identifier-check eval: would a message be stored UNREWRITTEN if the
// redaction model refused it? Runs the two nets redaction.service.ts uses for
// that decision (the hard rules and capitalised-word check, then the
// Decisions API identifier questions) over an invented fixture and reports,
// per class, how many messages each net stops.
//
// The number that matters is "has an identifier AND would be stored
// unrewritten": it must be zero.
//
// Input: evals/goldens/redaction-passthrough-hard.jsonl by default (invented
// text; lower-case names, sentence-initial names, numbers, handles, names
// that are also ordinary words, all capitals). Never point this at
// participant data. Needs OPENAI_API_KEY; one Decisions call per message per
// run (input tokens only). Never run in CI.
//
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-identifier-check-eval.mjs [--runs 3] [--fixture path]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { askIdentifierKinds } from '../src/server/services/identifierCheck.js';
import { PASSTHROUGH_MAX_P, blockedFromPassthrough } from '../src/server/services/redaction.service.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const RUNS = Number(arg('runs', '3'));
const FIXTURE = arg(
  'fixture',
  fileURLToPath(new URL('../evals/goldens/redaction-passthrough-hard.jsonl', import.meta.url)),
);
const cases = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 });
const rows = [];
for (let run = 1; run <= RUNS; run++) {
  await Promise.all(
    cases.map(async (c) => {
      const rule = blockedFromPassthrough(c.text);
      const answer = await askIdentifierKinds(client, c.text);
      rows.push({ ...c, run, rule, pMax: answer.pMax, stored: !rule && answer.pMax < PASSTHROUGH_MAX_P });
    }),
  );
}

console.log(
  'class | n | stopped by a rule | stopped by the classifier (asked regardless) | would be stored unrewritten',
);
for (const cls of [...new Set(cases.map((c) => c.class))]) {
  const g = rows.filter((r) => r.class === cls);
  console.log(
    `${cls} | ${g.length} | ${g.filter((r) => r.rule).length} | ${g.filter((r) => r.pMax >= PASSTHROUGH_MAX_P).length} | ${g.filter((r) => r.stored).length}`,
  );
}
const wrong = rows.filter((r) => r.has && r.stored);
console.log(`\nhas an identifier AND would be stored unrewritten: ${wrong.length}/${rows.filter((r) => r.has).length}`);
for (const r of wrong) console.log(`  ${r.id} run ${r.run} p=${r.pMax.toFixed(3)}`);
const low = rows.filter((r) => r.has).sort((a, b) => a.pMax - b.pMax)[0];
console.log(`lowest classifier probability on a message with an identifier: ${low.pMax.toFixed(3)} (${low.id})`);
const none = rows.filter((r) => !r.has);
console.log(`no identifier: ${none.filter((r) => r.stored).length}/${none.length} would be stored unrewritten`);
process.exit(wrong.length > 0 ? 1 : 0);
