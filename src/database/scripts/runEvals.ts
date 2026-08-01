// Offline session-eval runner (eval harness v1 — see docs/eval-system.md).
//
// Usage:
//   npx tsx src/database/scripts/runEvals.ts --session <sessionId> [--force]
//   npx tsx src/database/scripts/runEvals.ts --all-ended [--force]
//   npx tsx src/database/scripts/runEvals.ts --all-ended --judge-model gpt-5-mini
//
// Idempotent: sessions already evaluated under the current EVAL_PROMPT_VERSION
// are skipped unless --force is given. Requires OPENAI_API_KEY (or AWS secret)
// and a reachable database.
import { pool } from '../../server/config/db.js';
import {
  evaluateSession,
  evaluateAllEnded,
  EVAL_PROMPT_VERSION,
} from '../../server/services/sessionEval.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const sessionId = getArg('--session');
  const allEnded = process.argv.includes('--all-ended');
  const force = process.argv.includes('--force');
  const judgeModel = getArg('--judge-model');

  if (!sessionId && !allEnded) {
    console.log('Usage: npx tsx src/database/scripts/runEvals.ts (--session <id> | --all-ended) [--force] [--judge-model <model>]');
    process.exitCode = 1;
    return;
  }

  console.log(`[Evals] prompt version ${EVAL_PROMPT_VERSION}${force ? ' (force re-run)' : ''}`);

  if (sessionId) {
    const row = await evaluateSession(sessionId, { force, judgeModel });
    if (!row) {
      console.log(`[Evals] ${sessionId}: skipped (not found / not ended / empty transcript / already evaluated)`);
    } else {
      console.log(`[Evals] ${sessionId}: stored eval #${row.eval_id} (judge ${row.judge_model})`);
      for (const [dim, entry] of Object.entries(row.rubric)) {
        console.log(`  ${dim}: ${entry.score}/5 — ${entry.rationale}`);
      }
      if (row.overall_comments) console.log(`  overall: ${row.overall_comments}`);
    }
  } else {
    const result = await evaluateAllEnded({ force, judgeModel });
    console.log(`[Evals] done: ${result.evaluated} evaluated, ${result.skipped} skipped, ${result.failed} failed`);

    // Run one drift check over the freshly-scored corpus (ai-therapist-84).
    const { checkEvalDrift } = await import('../../server/services/evalDrift.service.js');
    const drift = await checkEvalDrift();
    console.log(`[Evals] drift check: ${drift.checked} bucket-dimensions checked, ${drift.alerted} new alert(s)`);

    if (result.failed > 0) process.exitCode = 1;
  }
}

main()
  .catch(err => {
    console.error('[Evals] fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
