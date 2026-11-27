// Session-features judge eval (ai-therapist-172): runs the codebook judge
// (src/server/services/sessionFeatures.ts) over invented session transcripts
// with an intended label per variable and reports agreement with the
// intended labels and stability.
//
// Input: evals/goldens/session-features.jsonl (invented text) and, for
// --paraphrases, evals/goldens/session-features-paraphrases.jsonl. Never
// point this at participant data. Needs OPENAI_API_KEY; one Decisions call
// per transcript per run (input tokens only), none for a transcript under the
// length floor. Billed. Never run in CI.
//
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/session-features-eval.mjs [--runs 3] [--out results.json]
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/session-features-eval.mjs --perturb [--out results.json]
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/session-features-eval.mjs --paraphrases [--out results.json]
//   node node_modules/.bin/tsx scripts/session-features-eval.mjs --print-codebook     (no API call)
//
// Default: every golden transcript, --runs times as written. Agreement per
// variable and run-to-run stability.
// --perturb: one run per meaning-preserving mechanical variant of each
//   transcript (as written; a neutral greeting added in front; a neutral
//   goodbye added at the end; participant turns lower-cased with final
//   punctuation removed, the way a speech transcript can arrive).
// --paraphrases: each hand-written paraphrase and its original, once each;
//   how often the two get the same answer.
//
// A predicate answer is present / absent / uncertain (probability between
// the two thresholds) / unknown (no usable answer). Only present and absent
// can agree with an intended label; uncertain and unknown are counted apart
// and never as agreement. Cells a golden lists under "ambiguous" are scored
// apart too.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { belowLengthFloor, renderTranscript, transcriptStats } from '../src/server/services/allianceMarkers.js';
import {
  ABSENT_MAX_P,
  CHOICE_MIN_P,
  FEATURE_CAUTIONS,
  FEATURE_GROUPS,
  FEATURE_GROUP_TITLES,
  PRESENT_MIN_P,
  SESSION_FEATURE_SET_VERSION,
  SESSION_FEATURES,
  askSessionFeatures,
} from '../src/server/services/sessionFeatures.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

if (args.includes('--print-codebook')) {
  for (const group of FEATURE_GROUPS) {
    console.log(`\n### ${FEATURE_GROUP_TITLES[group]}\n`);
    console.log('| variable | type | definition | counts | does not count | invented example |');
    console.log('|---|---|---|---|---|---|');
    for (const f of SESSION_FEATURES.filter((x) => x.group === group)) {
      const type = f.type === 'predicate' ? 'yes/no' : `one of: ${f.choices.map((c) => c.value).join(', ')}`;
      const mark = FEATURE_CAUTIONS[f.name] ? ' (weak, see below)' : '';
      console.log(`| \`${f.name}\`${mark} | ${type} | ${f.definition} | ${f.include} | ${f.exclude} | ${f.example} |`);
      if (f.type === 'choice') {
        for (const c of f.choices) console.log(`| | \`${c.value}\` | ${c.description} | | | |`);
      }
    }
  }
  process.exit(0);
}

const PERTURB = args.includes('--perturb');
const PARAPHRASES = args.includes('--paraphrases');
const OUT = arg('out', null);
const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

const goldens = readJsonl(arg('fixture', here('../evals/goldens/session-features.jsonl')));
const byId = new Map(goldens.map((c) => [c.id, c]));

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

const toTurns = (c) => c.turns.map(([who, text]) => ({ role: who === 'p' ? 'participant' : 'assistant', text }));

// The work list: { id (golden the labels come from), arm (run / variant / original|paraphrase), turns }.
let arms;
const work = [];
if (PARAPHRASES) {
  const paraphrases = readJsonl(arg('paraphrase-fixture', here('../evals/goldens/session-features-paraphrases.jsonl')));
  arms = ['original', 'paraphrase'];
  for (const p of paraphrases) {
    const original = byId.get(p.paraphrase_of);
    if (!original) throw new Error(`paraphrase ${p.id} names an unknown golden ${p.paraphrase_of}`);
    work.push({ id: original.id, arm: 0, turns: toTurns(original) });
    work.push({ id: original.id, arm: 1, turns: toTurns(p) });
  }
} else if (PERTURB) {
  arms = VARIANTS.map(([label]) => label);
  for (const c of goldens) VARIANTS.forEach(([, fn], i) => work.push({ id: c.id, arm: i, turns: fn(toTurns(c)) }));
} else {
  const runs = Number(arg('runs', '3'));
  arms = Array.from({ length: runs }, (_, i) => `run ${i + 1}`);
  for (const c of goldens) arms.forEach((_, i) => work.push({ id: c.id, arm: i, turns: toTurns(c) }));
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000 });
let calls = 0;
let tokensIn = 0;
const rows = [];
// One arm at a time, the transcripts of an arm in parallel.
for (let a = 0; a < arms.length; a++) {
  await Promise.all(
    work
      .filter((w) => w.arm === a)
      .map(async (w) => {
        if (belowLengthFloor(transcriptStats(w.turns))) {
          rows.push({ id: w.id, arm: a, status: 'too_short', features: null });
          return;
        }
        try {
          const answer = await askSessionFeatures(client, renderTranscript(w.turns).text);
          calls++;
          tokensIn += answer.tokensIn ?? 0;
          rows.push({ id: w.id, arm: a, status: 'extracted', features: answer.features, tokensIn: answer.tokensIn });
        } catch (err) {
          calls++;
          rows.push({ id: w.id, arm: a, status: 'errored', features: null, error: String(err?.message ?? err) });
        }
      }),
  );
}

/** What the judge said for one variable, as one word. */
const got = (feature, value) => {
  if (!value || value.kind === 'unknown') return 'unknown';
  if (feature.type === 'predicate') return value.present === null ? 'uncertain' : value.present ? 'present' : 'absent';
  return value.value ?? 'uncertain';
};
/** What the golden intends for one variable. */
const intended = (feature, c) =>
  feature.type === 'predicate' ? (c.present.includes(feature.name) ? 'present' : 'absent') : c.choices[feature.name];

const coded = rows.filter((r) => r.status === 'extracted');
const unit = PARAPHRASES ? 'versions' : PERTURB ? 'variants' : 'runs';
console.log(
  `feature set ${SESSION_FEATURE_SET_VERSION}: ${SESSION_FEATURES.length} variables; present >= ${PRESENT_MIN_P}, absent <= ${ABSENT_MAX_P}, choice >= ${CHOICE_MIN_P}`,
);
console.log(
  `${new Set(work.map((w) => w.id)).size} transcripts x ${arms.length} ${unit}: ${calls} model calls, ` +
    `${rows.filter((r) => r.status === 'too_short').length} under the length floor (no call), ` +
    `${rows.filter((r) => r.status === 'errored').length} errored`,
);
arms.forEach((label, i) => console.log(`  ${unit} ${i + 1}: ${label}`));
for (const r of rows.filter((x) => x.status === 'errored'))
  console.log(`  errored: ${r.id} [${arms[r.arm]}] ${r.error}`);

// ---- agreement with the intended labels, per variable (every coded row counts)
console.log(
  `\nagreement with the intended label, per variable (cells = coded transcripts x ${unit}; ambiguous cells apart)`,
);
console.log(
  'variable | cells | agree | intended present: hit/miss | intended absent: correct/false alarm | uncertain | unknown',
);
const perVariable = [];
const totals = { cells: 0, agree: 0, uncertain: 0, unknown: 0, ambiguous: 0, ambiguousAgree: 0 };
const misses = [];
for (const feature of SESSION_FEATURES) {
  const v = { name: feature.name, type: feature.type, cells: 0, agree: 0, hit: 0, miss: 0, correct: 0, falseAlarm: 0 };
  v.uncertain = 0;
  v.unknown = 0;
  v.wrongChoice = 0;
  for (const r of coded) {
    const c = byId.get(r.id);
    const want = intended(feature, c);
    const have = got(feature, r.features[feature.name]);
    if ((c.ambiguous ?? []).includes(feature.name)) {
      totals.ambiguous++;
      if (have === want) totals.ambiguousAgree++;
      continue;
    }
    v.cells++;
    if (have === 'uncertain') v.uncertain++;
    else if (have === 'unknown') v.unknown++;
    if (have === want) v.agree++;
    else
      misses.push({
        id: r.id,
        arm: arms[r.arm],
        variable: feature.name,
        intended: want,
        got: have,
        value: r.features[feature.name],
      });
    if (feature.type === 'predicate') {
      if (want === 'present') have === 'present' ? v.hit++ : have === 'absent' ? v.miss++ : 0;
      else have === 'absent' ? v.correct++ : have === 'present' ? v.falseAlarm++ : 0;
    } else if (have !== want && have !== 'uncertain' && have !== 'unknown') v.wrongChoice++;
  }
  perVariable.push(v);
  totals.cells += v.cells;
  totals.agree += v.agree;
  totals.uncertain += v.uncertain;
  totals.unknown += v.unknown;
  console.log(
    feature.type === 'predicate'
      ? `${v.name} | ${v.cells} | ${v.agree} | ${v.hit}/${v.miss} | ${v.correct}/${v.falseAlarm} | ${v.uncertain} | ${v.unknown}`
      : `${v.name} | ${v.cells} | ${v.agree} | (choice: ${v.wrongChoice} wrong option) | | ${v.uncertain} | ${v.unknown}`,
  );
}
console.log(
  `all variables: ${totals.agree}/${totals.cells} agree, ${totals.uncertain} uncertain, ${totals.unknown} unknown; ` +
    `ambiguous cells (apart): ${totals.ambiguousAgree}/${totals.ambiguous} matched the label given`,
);
const predicates = perVariable.filter((v) => v.type === 'predicate');
const sum = (key) => predicates.reduce((n, v) => n + v[key], 0);
console.log(
  `yes/no variables: intended present ${sum('hit')} hit, ${sum('miss')} missed; ` +
    `intended absent ${sum('correct')} correct, ${sum('falseAlarm')} false alarms`,
);

console.log('\ncells that did not match (id [arm] variable: intended -> got)');
for (const m of misses) {
  const detail =
    m.value?.kind === 'predicate'
      ? `p=${m.value.p}`
      : m.value?.kind === 'choice'
        ? JSON.stringify(m.value.p)
        : (m.value?.reason ?? '');
  console.log(`${m.id} [${m.arm}] ${m.variable}: ${m.intended} -> ${m.got} ${detail}`);
}

// ---- stability: per (transcript, variable) cell, the same answer in every arm?
if (arms.length > 1) {
  let cells = 0;
  let same = 0;
  let maxRange = 0;
  let sumRange = 0;
  let ranged = 0;
  const unstable = new Map();
  for (const id of new Set(coded.map((r) => r.id))) {
    const mine = coded.filter((r) => r.id === id);
    if (mine.length < arms.length) continue;
    for (const feature of SESSION_FEATURES) {
      cells++;
      const answers = mine.map((r) => got(feature, r.features[feature.name]));
      if (new Set(answers).size === 1) same++;
      else unstable.set(feature.name, (unstable.get(feature.name) ?? 0) + 1);
      const ps = mine
        .map((r) => r.features[feature.name])
        .map((v) => (v?.kind === 'predicate' ? v.p : v?.kind === 'choice' ? v.confidence : null))
        .filter((p) => p !== null);
      if (ps.length >= 2) {
        const range = Math.max(...ps) - Math.min(...ps);
        ranged++;
        sumRange += range;
        maxRange = Math.max(maxRange, range);
      }
    }
  }
  console.log(
    `\nstability over ${arms.length} ${unit} (${cells} transcript x variable cells, transcripts coded in every one)`,
  );
  console.log(`same answer in every one: ${same}/${cells}`);
  console.log(
    `range of the probability across ${unit}: mean ${ranged ? (sumRange / ranged).toFixed(4) : 'n/a'}, max ${maxRange.toFixed(4)}`,
  );
  console.log(
    `variables whose answer changed, with the number of transcripts: ${
      [...unstable.entries()].map(([k, n]) => `${k} (${n})`).join(', ') || 'none'
    }`,
  );
}

console.log(`\ninput tokens reported by the API: ${tokensIn} over ${calls} calls (a count, not a cost)`);

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      { featureSet: SESSION_FEATURE_SET_VERSION, mode: unit, arms, calls, tokensIn, perVariable, totals, misses, rows },
      null,
      2,
    ),
  );
  console.log(`results written to ${OUT}`);
}
