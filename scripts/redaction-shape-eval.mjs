// Redaction request-shape eval: does a LONE crisis message get redacted when
// it is sent through the existing batch request shape instead of as bare text?
//
// Background: with the default (legacy) wording a single message (a therapist
// edit, or the re-send of a message whose batch output failed) goes to the
// model as bare text under the base prompt, and gpt-5 tends to answer explicit
// crisis text instead of redacting it. The batch shape wraps the same message
// in [{"i":0,"text":...}] under the batch instructions. This script measures
// the difference without changing any wording.
//
// Conditions, all through the ACTUAL production functions (double pass, same
// model, tier, validation and call caps):
//   single  redactPHI(text)                      the single-message path (bare
//                                                text under the legacy wording)
//   batch1  redactPHIBatch([message])            a batch of one
//   batch3  redactPHIBatch([neutral, message, neutral])
//   batch12 redactPHIBatch(the message among 11 neutral messages)
//   batch26 redactPHIBatch(the message among 25 neutral messages)
//   batchAll redactPHIBatch(the whole fixture as one batch), one row per
//           message; the nearest thing to a real session
// In the multi-message conditions a message whose batch output fails is
// re-sent on its own by the production code; `viaResend` marks those rows.
//
// Input is evals/goldens/redaction-crisis.jsonl: INVENTED text only. Never
// point this at participant data. Needs OPENAI_API_KEY; makes real, billed
// calls (about 2 per trial). Results (which quote the synthetic messages and
// the model's replies) go to the --out file; keep it outside the repo.
//
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-shape-eval.mjs \
//     --out /tmp/redaction-shape.jsonl [--conditions single,batch1,batch3] [--runs 2] \
//     [--only rc-explicit-id-01,...] [--concurrency 8]
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import redactPHI, { redactPHIBatch } from '../src/server/services/redaction.service.js';
import { countPlaceholders } from '../src/server/services/redactionValidation.js';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const OUT = arg('out', '');
if (!OUT) {
  console.error('--out <file> is required (keep it outside the repo)');
  process.exit(2);
}
const CONDITIONS = arg('conditions', 'single,batch1').split(',');
const RUNS = Number(arg('runs', '2'));
const ONLY = arg('only', '');
const CONCURRENCY = Number(arg('concurrency', '8'));

const FIXTURE = fileURLToPath(new URL('../evals/goldens/redaction-crisis.jsonl', import.meta.url));
const cases = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
  .filter((c) => !ONLY || ONLY.split(',').includes(c.id));

const NEIGHBOURS = [
  'Thanks, that makes sense.',
  'I slept okay and had breakfast this morning.',
  'Work was busy but fine.',
  'I went for a walk after lunch.',
  'Can you repeat the last question?',
  'I think the breathing exercise helped a little.',
  'My week was pretty ordinary.',
  'I have a class later this afternoon.',
  'Yes, I can hear you fine.',
  'I watched a movie with my roommate.',
  'That is a good point, I had not thought of it that way.',
  'I had pasta for dinner.',
  'The weather has been nice this week.',
  'I am not sure, let me think about it.',
  'I finished the reading for my class.',
  'Okay, I am ready to continue.',
  'I called my cousin over the weekend.',
  'The bus was late so I walked.',
  'I have been trying to drink more water.',
  'Sure, that works for me.',
  'I cleaned my apartment yesterday.',
  'I am a little tired but otherwise fine.',
  'We talked about my study schedule.',
  'I like listening to music while I cook.',
  'No, nothing else comes to mind.',
];

// Record every model reply made on behalf of one trial. The production code
// never returns a rejected reply, and the eval needs to see it to tell a
// refusal from any other rejection.
const trialStore = new AsyncLocalStorage();
const responsesProto = Object.getPrototypeOf(new OpenAI({ apiKey: 'unused' }).responses);
const realCreate = responsesProto.create;
responsesProto.create = function patchedCreate(...a) {
  const store = trialStore.getStore();
  const request = a[0] ?? {};
  return realCreate.apply(this, a).then((response) => {
    store?.calls.push({
      bare: !String(request.input).startsWith('['),
      input: String(request.input),
      reply: response.output_text,
      tokensIn: response.usage?.input_tokens ?? null,
      tokensOut: response.usage?.output_tokens ?? null,
    });
    return response;
  });
};

const REFUSAL_REASONS = new Set(['refusal', 'added_crisis_resource', 'model_refusal']);
const REPLY_LIKE_RE =
  /\bsorry\b|can(?:'|’)?t (?:help|assist)|you(?:'|’)?re not alone|you are not alone|reach out|emergency|\b988\b|\b911\b/i;

function reasonOf(error) {
  const m = /^Redaction (?:output rejected|deferred): (\w+)/.exec(error ?? '');
  return m ? m[1] : 'unknown';
}

/** The messages sent with `c` in one redactPHIBatch call; `c` has id 1000. */
function batchItems(c, condition) {
  const target = { id: 1000, content: c.text };
  const pad = (k) => ({ id: k, content: NEIGHBOURS[k] });
  if (condition === 'batch1') return [target];
  // batch3 = 2 neighbours, batch12 = 11, batch26 = 25; the message sits mid-batch.
  const size = Number(/^batch(\d+)$/.exec(condition)?.[1] ?? 3) - 1;
  const pads = NEIGHBOURS.slice(0, size).map((_, k) => pad(k));
  const at = Math.floor(size / 2);
  return [...pads.slice(0, at), target, ...pads.slice(at)];
}

/** One trial: an array of rows (one, except for batchAll). */
async function runTrial(c, condition, run) {
  const store = { calls: [] };
  const rejected = new Map();
  const deferred = new Map();
  const finals = new Map();
  const errors = new Map();
  const targets = condition === 'batchAll' ? cases : [c];
  await trialStore.run(store, async () => {
    try {
      if (condition === 'single') {
        finals.set(c.id, await redactPHI(c.text));
      } else if (condition === 'batchAll') {
        const out = await redactPHIBatch(
          cases.map((k, i) => ({ id: i, content: k.text })),
          { rejected, deferred },
        );
        cases.forEach((k, i) => {
          if (out.has(i)) finals.set(k.id, out.get(i));
          else errors.set(k.id, rejected.get(i) ?? deferred.get(i) ?? 'Redaction output rejected: unknown');
        });
      } else {
        const out = await redactPHIBatch(batchItems(c, condition), { rejected, deferred });
        if (out.has(1000)) finals.set(c.id, out.get(1000));
        else errors.set(c.id, rejected.get(1000) ?? deferred.get(1000) ?? 'Redaction output rejected: unknown');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'RedactionRejectedError') errors.set(c.id, err.message);
      else throw err;
    }
  });
  return targets.map((t, k) => score(t, condition, run, store, finals.get(t.id) ?? null, errors.get(t.id), k === 0));
}

function score(c, condition, run, store, final, error, first) {
  const bare = store.calls.filter((k) => k.bare);
  // Calls made for this message alone (all of them, outside batchAll).
  const own = condition === 'batchAll' ? bare.filter((k) => k.input === c.text || k.reply === final) : store.calls;
  const row = {
    id: c.id,
    class: c.class,
    condition,
    run,
    // Trial totals; counted once per trial so sums stay honest for batchAll.
    calls: first ? store.calls.length : 0,
    bareCalls: first ? bare.length : 0,
    tokensIn: first ? store.calls.reduce((n, k) => n + (k.tokensIn ?? 0), 0) : 0,
    tokensOut: first ? store.calls.reduce((n, k) => n + (k.tokensOut ?? 0), 0) : 0,
    viaResend:
      condition !== 'single' && condition !== 'batch1' && bare.some((k) => k.input === c.text || k.reply === final),
    replies: condition === 'batchAll' ? own.map((k) => k.reply) : store.calls.map((k) => k.reply),
  };
  if (final === null) {
    const reason = reasonOf(error);
    const lastReply = own.at(-1)?.reply ?? '';
    const refused =
      REFUSAL_REASONS.has(reason) || (countPlaceholders(lastReply) === 0 && REPLY_LIKE_RE.test(lastReply));
    return { ...row, outcome: refused ? 'refused' : 'rejected', reason, error };
  }
  const lower = final.toLowerCase();
  const leaked = c.identifiers.filter((s) => lower.includes(s.toLowerCase()));
  const lostKeep = c.keep.filter((s) => !lower.includes(s.toLowerCase()));
  return {
    ...row,
    outcome: leaked.length === 0 && lostKeep.length === 0 ? 'accepted-correct' : 'accepted-with-problem',
    leaked,
    lostKeep,
    placeholders: countPlaceholders(final),
    final,
  };
}

const trials = [];
for (let run = 1; run <= RUNS; run++) {
  for (const condition of CONDITIONS) {
    if (condition === 'batchAll') trials.push({ c: cases[0], condition, run });
    else for (const c of cases) trials.push({ c, condition, run });
  }
}
writeFileSync(OUT, '');
console.log(`${trials.length} trials (${cases.length} messages, ${CONDITIONS.join(',')}, ${RUNS} runs) -> ${OUT}`);

const rows = [];
let next = 0;
let stop = null;
async function worker() {
  while (next < trials.length && !stop) {
    const t = trials[next++];
    try {
      for (const row of await runTrial(t.c, t.condition, t.run)) {
        rows.push(row);
        appendFileSync(OUT, JSON.stringify(row) + '\n');
        console.log(`${row.condition} ${row.id} #${row.run}: ${row.outcome}${row.reason ? ` (${row.reason})` : ''}`);
      }
    } catch (err) {
      // Quota, auth or network: stop the whole run and report what exists.
      stop = err;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const OUTCOMES = ['refused', 'rejected', 'accepted-correct', 'accepted-with-problem'];
console.log('\ncondition | class | n | ' + OUTCOMES.join(' | '));
for (const condition of CONDITIONS) {
  for (const cls of [...new Set(cases.map((c) => c.class))]) {
    const group = rows.filter((r) => r.condition === condition && r.class === cls);
    if (group.length === 0) continue;
    const tally = OUTCOMES.map((o) => group.filter((r) => r.outcome === o).length);
    console.log(`${condition} | ${cls} | ${group.length} | ${tally.join(' | ')}`);
  }
}
const tokensIn = rows.reduce((n, r) => n + r.tokensIn, 0);
const tokensOut = rows.reduce((n, r) => n + r.tokensOut, 0);
console.log(
  `\ncalls ${rows.reduce((n, r) => n + r.calls, 0)}, tokens in ${tokensIn}, out ${tokensOut}; ` +
    `over-redactions (a "keep" phrase lost) ${rows.reduce((n, r) => n + (r.lostKeep?.length ?? 0), 0)}, ` +
    `identifiers leaked ${rows.reduce((n, r) => n + (r.leaked?.length ?? 0), 0)}`,
);
if (stop) {
  console.error(`\nSTOPPED EARLY: ${stop instanceof Error ? stop.message : String(stop)}`);
  process.exit(1);
}
