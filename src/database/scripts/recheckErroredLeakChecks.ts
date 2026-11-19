// Redacted messages whose leak check errored (ai-therapist-288): list them,
// and optionally run the leak check over them again.
//
// Usage:
//   npx tsx src/database/scripts/recheckErroredLeakChecks.ts [--session <id>] [--limit <n>] [--include-reviewed]
//   npx tsx src/database/scripts/recheckErroredLeakChecks.ts --requeue [--session <id>] [--limit <n>]
//
// Default is LIST ONLY: no OpenAI call and no write. It prints how many
// errored rows there are (the ai-therapist-284 outage rows included: they
// carry `error` with flagged=false and count as errored), how many sessions
// they span, the date range, the error texts, and an estimated cost of
// re-checking them. It never prints message text.
//
// --requeue re-runs the verifier over the listed, unreviewed rows (one OpenAI
// call each, on the backend system_config.redaction_verifier selects; usage
// is recorded under purpose `redaction`) and overwrites each row's
// redaction_check with the new verdict. A row that errors again stays errored
// and stays in the review queue. Rows a researcher has reviewed are never
// re-checked. Run on stage first; prod had 0 messages as of 2026-11-16.
//
// Reads DATABASE_URL like the app. Not run by CI.
import { pool } from '../../server/config/db.js';
import {
  estimateRecheckCost,
  listErroredLeakChecks,
  recheckErroredLeakChecks,
  summarizeErrored,
} from '../../server/services/leakCheckRecheck.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 6 : n < 1 ? 4 : 2)}`;

async function main() {
  const requeue = process.argv.includes('--requeue');
  const includeReviewed = process.argv.includes('--include-reviewed');
  const sessionId = getArg('--session') ?? null;
  const limitArg = getArg('--limit');
  const limit = limitArg === undefined ? null : Number(limitArg);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`[LeakRecheck] --limit must be a positive integer, got ${limitArg}`);
    process.exitCode = 1;
    return;
  }

  const rows = await listErroredLeakChecks({ includeReviewed, sessionId, limit });
  const s = summarizeErrored(rows);
  console.log(
    `[LeakRecheck] ${s.total} redacted message(s) with an errored leak check` +
      (includeReviewed ? ` (${s.reviewed} already reviewed)` : ' (unreviewed)') +
      ` across ${s.sessions} session(s)` +
      (s.total ? `; messages from ${s.firstMessageAt} to ${s.lastMessageAt}` : ''),
  );
  for (const e of s.byError) console.log(`  ${String(e.count).padStart(6)}  ${e.error}`);

  const toRecheck = rows.filter((r) => !r.reviewed);
  const est = estimateRecheckCost(toRecheck);
  console.log(
    `[LeakRecheck] re-checking ${est.rows} row(s) would make ${est.rows} OpenAI call(s), about ` +
      `${est.inputTokens.toLocaleString('en-US')} input tokens: estimated ${usd(est.decisionsUsd)} on the ` +
      `Decisions API, up to ${usd(est.responsesUsd)} if every call falls back to the Responses API (estimate, not billing)`,
  );

  if (!requeue) {
    console.log('[LeakRecheck] list only: nothing was sent or written. Re-run with --requeue to re-check these rows.');
    return;
  }
  if (est.rows === 0) {
    console.log('[LeakRecheck] nothing to re-check.');
    return;
  }
  console.log(`[LeakRecheck] --requeue: re-checking ${est.rows} row(s) now...`);
  const result = await recheckErroredLeakChecks(toRecheck);
  console.log(
    `[LeakRecheck] done: ${result.checked} checked (${result.flagged} flagged for review), ` +
      `${result.errored} errored again, over ${result.sessions} session(s)` +
      (result.checked + result.errored === 0
        ? '. Nothing was checked: is system_config.redaction_verifier.enabled false?'
        : ''),
  );
}

main()
  .catch((err) => {
    console.error('[LeakRecheck] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
