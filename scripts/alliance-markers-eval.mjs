// Alliance-marker judge eval (ai-therapist-173): runs the Task / Bond / Goal
// judge (src/server/services/allianceMarkers.ts) over invented session
// transcripts with intended levels and reports agreement with the intended
// level and run-to-run stability.
//
// Input: evals/goldens/alliance-markers.jsonl by default (invented text).
// Never point this at participant data. Needs OPENAI_API_KEY; one Decisions
// call per transcript per run (input tokens only), none for a transcript
// under the length floor. Never run in CI.
//
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/alliance-markers-eval.mjs [--runs 5] [--fixture path] [--out results.json]
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/alliance-markers-eval.mjs --perturb [--out results.json]
//
// --perturb replaces the repeat runs with one run per meaning-preserving
// variant of each transcript (as written; a neutral greeting added in front;
// a neutral goodbye added at the end; participant turns lower-cased with
// final punctuation removed, the way a speech transcript can arrive). The
// endpoint returns the same numbers for the same input, so repeat runs say
// little; the variants show how far a rating moves when only the surface of
// the text changes.
//
// Bands: a level of 1 or 2 is "low", 3 is "mid", 4 or 5 is "high"; a subscale
// the judge will not rate is "not_rateable".
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import {
  ALLIANCE_JUDGE_VERSION,
  ALLIANCE_SUBSCALES,
  askAllianceJudge,
  belowLengthFloor,
  renderTranscript,
  transcriptStats,
} from '../src/server/services/allianceMarkers.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PERTURB = args.includes('--perturb');

/** Meaning-preserving variants of a transcript, the original first. */
const VARIANTS = [
  ['as written', (turns) => turns],
  ['greeting added in front', (turns) => [{ role: 'assistant', text: 'Hello.' }, ...turns]],
  ['goodbye added at the end', (turns) => [...turns, { role: 'assistant', text: 'Take care. Goodbye.' }]],
  [
    'participant turns lower-cased, final punctuation removed',
    (turns) =>
      turns.map((t) => (t.role === 'participant' ? { ...t, text: t.text.toLowerCase().replace(/[.!?]+$/u, '') } : t)),
  ],
];
const RUNS = PERTURB ? VARIANTS.length : Number(arg('runs', '5'));
const FIXTURE = arg('fixture', fileURLToPath(new URL('../evals/goldens/alliance-markers.jsonl', import.meta.url)));
const OUT = arg('out', null);

const cases = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

export const band = (rating) =>
  !rating.rateable ? 'not_rateable' : rating.level <= 2 ? 'low' : rating.level === 3 ? 'mid' : 'high';

const NOT_RATEABLE = { rateable: false, pRateable: 0, score: null, level: null, confidence: null, distribution: null };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000 });
const rows = [];
let calls = 0;
let tokensIn = 0;
for (let run = 1; run <= RUNS; run++) {
  await Promise.all(
    cases.map(async (c) => {
      const written = c.turns.map(([who, text]) => ({ role: who === 'p' ? 'participant' : 'assistant', text }));
      const turns = PERTURB ? VARIANTS[run - 1][1](written) : written;
      if (belowLengthFloor(transcriptStats(turns))) {
        rows.push({
          id: c.id,
          run,
          floor: true,
          subscales: { task: NOT_RATEABLE, bond: NOT_RATEABLE, goal: NOT_RATEABLE },
        });
        return;
      }
      const answer = await askAllianceJudge(client, renderTranscript(turns).text);
      calls++;
      tokensIn += answer.tokensIn ?? 0;
      rows.push({ id: c.id, run, floor: false, subscales: answer.subscales });
    }),
  );
}

const cell = (r) => (r.rateable ? `${r.level} (${r.score.toFixed(2)})` : `n/r p=${r.pRateable.toFixed(2)}`);
const unit = PERTURB ? 'variants' : 'runs';
console.log(`judge ${ALLIANCE_JUDGE_VERSION}, ${cases.length} transcripts x ${RUNS} ${unit}, ${calls} model calls`);
if (PERTURB) VARIANTS.forEach(([label], i) => console.log(`  variant ${i + 1}: ${label}`));
console.log(
  `\nid | subscale | intended | per ${PERTURB ? 'variant' : 'run'}: level (mean score), or n/r with p(rateable)`,
);
for (const c of cases) {
  for (const s of ALLIANCE_SUBSCALES) {
    const mine = rows.filter((r) => r.id === c.id).sort((a, b) => a.run - b.run);
    console.log(`${c.id} | ${s} | ${c.expected[s]} | ${mine.map((r) => cell(r.subscales[s])).join(', ')}`);
  }
}

// Agreement with the intended band, per subscale and overall (every run counts).
console.log(`\nagreement with the intended band (ratings = transcripts x ${unit})`);
let agreeAll = 0;
let nAll = 0;
for (const s of ALLIANCE_SUBSCALES) {
  let agree = 0;
  let n = 0;
  for (const r of rows) {
    const intended = cases.find((c) => c.id === r.id).expected[s];
    n++;
    if (band(r.subscales[s]) === intended) agree++;
  }
  agreeAll += agree;
  nAll += n;
  console.log(`${s}: ${agree}/${n}`);
}
console.log(`all subscales: ${agreeAll}/${nAll}`);

// The two errors that matter most, counted apart from band agreement.
let lowForNotRateable = 0;
let nNotRateable = 0;
let oppositePole = 0;
let nPoled = 0;
for (const r of rows) {
  const expected = cases.find((c) => c.id === r.id).expected;
  for (const s of ALLIANCE_SUBSCALES) {
    const got = band(r.subscales[s]);
    if (expected[s] === 'not_rateable') {
      nNotRateable++;
      if (got !== 'not_rateable') lowForNotRateable++;
    }
    if (expected[s] === 'high' || expected[s] === 'low') {
      nPoled++;
      if ((expected[s] === 'high' && got === 'low') || (expected[s] === 'low' && got === 'high')) oppositePole++;
    }
  }
}
console.log(`intended not rateable but given a score: ${lowForNotRateable}/${nNotRateable}`);
console.log(`intended high rated low, or intended low rated high: ${oppositePole}/${nPoled}`);

// Run-to-run stability: per (transcript, subscale) cell, did every run land on
// the same level / the same band, and how far apart were the mean scores.
let cells = 0;
let sameLevel = 0;
let sameBand = 0;
let maxRange = 0;
let sumRange = 0;
let scored = 0;
for (const c of cases) {
  for (const s of ALLIANCE_SUBSCALES) {
    const mine = rows.filter((r) => r.id === c.id).map((r) => r.subscales[s]);
    cells++;
    if (new Set(mine.map((m) => (m.rateable ? m.level : 'n/r'))).size === 1) sameLevel++;
    if (new Set(mine.map(band)).size === 1) sameBand++;
    const scores = mine.filter((m) => m.rateable).map((m) => m.score);
    if (scores.length >= 2) {
      const range = Math.max(...scores) - Math.min(...scores);
      scored++;
      sumRange += range;
      maxRange = Math.max(maxRange, range);
    }
  }
}
console.log(`\nstability over ${RUNS} ${unit} (${cells} transcript x subscale cells)`);
console.log(`same level in every one: ${sameLevel}/${cells}`);
console.log(`same band in every one: ${sameBand}/${cells}`);
console.log(
  `range of the mean score across ${unit}: mean ${scored ? (sumRange / scored).toFixed(3) : 'n/a'}, max ${maxRange.toFixed(3)} (${scored} cells scored at least twice)`,
);
console.log(`\ninput tokens reported by the API: ${tokensIn} over ${calls} calls (a count, not a cost)`);

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify({ judge: ALLIANCE_JUDGE_VERSION, perturb: PERTURB, runs: RUNS, calls, tokensIn, rows }, null, 2),
  );
  console.log(`results written to ${OUT}`);
}
