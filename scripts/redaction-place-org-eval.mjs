// Redaction place / organisation eval: how often does the redaction step leave
// an identifying place or organisation name in a message, and does the leak
// check that runs after redaction flag the ones it leaves?
//
// Background: docs/redaction-shape-eval-2026-11-26.md found one school name
// surviving redaction in 12 of 15 accepted outputs. That was one fixture
// item. This script measures the rate over a fixture of ordinary messages,
// one identifier each, across eight classes of place and organisation name,
// with controls.
//
// What runs, all through the ACTUAL production functions and defaults:
//   1. redactPHIBatch (gpt-5, flex tier, reasoning effort low, double pass,
//      validation, call caps, legacy wording) over the fixture in session-like
//      batches of --batch messages. The messages are shuffled per run (seeded),
//      so each batch mixes classes and the batches differ between runs.
//   2. askLeakCheck (redactionVerifier.service.ts) on every accepted output,
//      with DEFAULT_VERIFIER_CONFIG (backend auto, threshold 0.5), which is
//      what migration 110 seeds. Only redacted text is sent, as in production.
//      No database is read or written: the config is the code default, not
//      whatever a deployment has in system_config.
//
// Per message and run the outcome is one of:
//   removed   stored; no listed string of the identifier is left
//   survived  stored; a listed string is still there (case-insensitive)
//   rejected  not stored: the output failed validation (reason recorded)
// Messages with nothing to redact (class control-none) are "removed" when
// accepted; `placeholders` shows whether anything was redacted in them.
//
// Input is evals/goldens/redaction-place-org.jsonl: INVENTED text only. Never
// point this at participant data. Needs OPENAI_API_KEY; makes real, billed
// calls (2 redaction calls per batch plus one leak-check call per accepted
// output; about $0.50 for the default 3 runs). Never run in CI. The --out
// file quotes the synthetic messages and the model's outputs; keep it outside
// the repo.
//
//   OPENAI_API_KEY=... node node_modules/.bin/tsx scripts/redaction-place-org-eval.mjs \
//     --out /somewhere/outside/the/repo/redaction-place-org.jsonl \
//     [--runs 3] [--batch 10] [--seed 1] [--concurrency 5] [--skip-leak-check] \
//     [--wording evals/candidates/redaction-wording-orgs.json]
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { applyCandidateWording } from './redaction-eval-wording.mjs';
import { redactPHIBatch } from '../src/server/services/redaction.service.js';
import { countPlaceholders } from '../src/server/services/redactionValidation.js';
import { askLeakCheck, DEFAULT_VERIFIER_CONFIG } from '../src/server/services/redactionVerifier.service.js';

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
const RUNS = Number(arg('runs', '3'));
const BATCH = Number(arg('batch', '10'));
const SEED = Number(arg('seed', '1'));
const CONCURRENCY = Number(arg('concurrency', '5'));
const LEAK_CHECK = !args.includes('--skip-leak-check');

const FIXTURE = fileURLToPath(new URL('../evals/goldens/redaction-place-org.jsonl', import.meta.url));
const cases = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));
const CLASSES = [...new Set(cases.map((c) => c.class))];

// Token usage by model and by the service tier the API says it used (a flex
// request falls back to the default tier when flex has no capacity, at twice
// the price), read off every reply.
const usage = new Map();
function patchUsage(resource) {
  const proto = Object.getPrototypeOf(resource);
  const realCreate = proto.create;
  proto.create = function patchedCreate(...a) {
    return realCreate.apply(this, a).then((response) => {
      const key = `${response.model ?? a[0]?.model ?? 'unknown'} / ${response.service_tier ?? 'tier not reported'}`;
      const u = usage.get(key) ?? { calls: 0, tokensIn: 0, tokensOut: 0 };
      u.calls++;
      u.tokensIn += response.usage?.input_tokens ?? 0;
      u.tokensOut += response.usage?.output_tokens ?? 0;
      usage.set(key, u);
      return response;
    });
  };
}
const probe = new OpenAI({ apiKey: 'unused' });
patchUsage(probe.responses);
patchUsage(probe.decisions);
// --wording <file>: measure a candidate wording (see redaction-eval-wording.mjs).
const WORDING = applyCandidateWording(probe.responses, arg('wording', ''));

/** Deterministic shuffle, so a run can be repeated with the same batches. */
function shuffled(list, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function reasonOf(error) {
  const m = /^Redaction (?:output rejected|deferred): (\w+)/.exec(error ?? '');
  return m ? m[1] : 'unknown';
}

/** Quota or auth: nothing further will succeed, so the run stops. */
function isFatal(err) {
  const status = err?.status;
  const message = err instanceof Error ? err.message : String(err);
  return status === 401 || status === 403 || /insufficient_quota|exceeded your current quota/i.test(message);
}

const jobs = [];
for (let run = 1; run <= RUNS; run++) {
  const order = shuffled(cases, SEED * 1000 + run);
  for (let start = 0; start < order.length; start += BATCH) {
    jobs.push({ run, batch: start / BATCH + 1, items: order.slice(start, start + BATCH) });
  }
}
writeFileSync(OUT, '');
console.log(
  `${cases.length} messages x ${RUNS} runs in ${jobs.length} batches of up to ${BATCH} -> ${OUT} (${WORDING})`,
);

const rows = [];
let stop = null;

async function pool(list, size, fn) {
  let next = 0;
  async function worker() {
    while (next < list.length && !stop) {
      const item = list[next++];
      try {
        await fn(item);
      } catch (err) {
        stop = err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, worker));
}

// ---- 1. redaction ----------------------------------------------------------
await pool(jobs, CONCURRENCY, async (job) => {
  const rejected = new Map();
  const deferred = new Map();
  const out = await redactPHIBatch(
    job.items.map((c, i) => ({ id: i, content: c.text })),
    { rejected, deferred },
  );
  job.items.forEach((c, i) => {
    const row = { id: c.id, class: c.class, run: job.run, batch: job.batch, position: i };
    if (!out.has(i)) {
      const error = rejected.get(i) ?? deferred.get(i) ?? 'Redaction output rejected: unknown';
      rows.push({ ...row, outcome: 'rejected', reason: reasonOf(error), error });
      return;
    }
    const final = out.get(i);
    const lower = final.toLowerCase();
    const leaked = c.match.filter((s) => lower.includes(s.toLowerCase()));
    rows.push({
      ...row,
      outcome: leaked.length > 0 ? 'survived' : 'removed',
      leaked,
      placeholders: countPlaceholders(final),
      final,
    });
  });
  console.log(`redaction run ${job.run} batch ${job.batch}: done`);
});

// ---- 2. leak check on every accepted output --------------------------------
if (LEAK_CHECK && !stop) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 });
  const accepted = rows.filter((r) => r.outcome !== 'rejected');
  await pool(accepted, 4, async (row) => {
    try {
      const answer = await askLeakCheck(row.final, DEFAULT_VERIFIER_CONFIG, client);
      row.leakCheck = {
        status: 'checked',
        pLeak: Number(answer.pLeak.toFixed(4)),
        flagged: answer.pLeak >= DEFAULT_VERIFIER_CONFIG.threshold,
        backend: answer.backend,
        model: answer.model,
      };
    } catch (err) {
      if (isFatal(err)) throw err;
      // Production records this as status 'errored' (unknown, not clean).
      row.leakCheck = { status: 'errored', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  });
  console.log(`leak check: ${accepted.filter((r) => r.leakCheck).length}/${accepted.length} outputs asked`);
}

for (const row of rows.sort((a, b) => a.run - b.run || a.id.localeCompare(b.id))) {
  appendFileSync(OUT, JSON.stringify(row) + '\n');
}

// ---- tally -----------------------------------------------------------------
const frac = (k, n) => (n === 0 ? 'none' : `${k}/${n}`);
function leakTally(group) {
  const checked = group.filter((r) => r.leakCheck?.status === 'checked');
  return {
    flagged: checked.filter((r) => r.leakCheck.flagged).length,
    checked: checked.length,
    errored: group.filter((r) => r.leakCheck?.status === 'errored').length,
  };
}
console.log(
  '\nclass | n | removed | survived | rejected | survivors flagged by the leak check | clean outputs flagged | leak checks errored',
);
for (const cls of [...CLASSES, 'ALL']) {
  const group = rows.filter((r) => cls === 'ALL' || r.class === cls);
  const survived = group.filter((r) => r.outcome === 'survived');
  const removed = group.filter((r) => r.outcome === 'removed');
  const rejectedRows = group.filter((r) => r.outcome === 'rejected');
  const s = leakTally(survived);
  const c = leakTally(removed);
  console.log(
    `${cls} | ${group.length} | ${removed.length} | ${survived.length} | ${rejectedRows.length} | ` +
      `${frac(s.flagged, s.checked)} | ${frac(c.flagged, c.checked)} | ${s.errored + c.errored}`,
  );
}

console.log('\nper message: id | survived in runs | removed | rejected | leak check flagged the survivors');
for (const c of cases) {
  const group = rows.filter((r) => r.id === c.id);
  const survived = group.filter((r) => r.outcome === 'survived');
  const s = leakTally(survived);
  console.log(
    `${c.id} | ${survived.length} | ${group.filter((r) => r.outcome === 'removed').length} | ` +
      `${group.filter((r) => r.outcome === 'rejected').length} | ${frac(s.flagged, s.checked)}`,
  );
}

const none = rows.filter((r) => r.class === 'control-none' && r.outcome !== 'rejected');
console.log(
  `\nmessages with nothing to redact that came back with a placeholder: ${none.filter((r) => r.placeholders > 0).length}/${none.length}`,
);
console.log('\nmodel / service tier | calls | tokens in | tokens out');
for (const [key, u] of usage) console.log(`${key} | ${u.calls} | ${u.tokensIn} | ${u.tokensOut}`);

if (stop) {
  console.error(`\nSTOPPED EARLY: ${stop instanceof Error ? stop.message : String(stop)}`);
  process.exit(1);
}
// The verifier module opens the app's Postgres pool on import (never used
// here); exit explicitly so an idle pool cannot hold the process open.
process.exit(0);
