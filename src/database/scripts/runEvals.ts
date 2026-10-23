// Offline session-eval runner (eval harness v1 — see docs/eval-system.md).
//
// Usage:
//   npx tsx src/database/scripts/runEvals.ts --session <sessionId> [--force]
//   npx tsx src/database/scripts/runEvals.ts --all-ended [--force]
//   npx tsx src/database/scripts/runEvals.ts --all-ended --judge-model gpt-5-mini
//   npx tsx src/database/scripts/runEvals.ts --session <id> --force --judge-models gpt-4o-mini,gpt-5-mini --self-consistency 3
//
// Judge ensemble (migration 107): by default every model in
// system_config.evals.judge_models (default gpt-4o-mini + gpt-5-mini) judges the
// session and the stored row is the per-dimension median. --judge-model pins a
// single judge; --judge-models / --self-consistency override the config.
// Idempotent: sessions already evaluated under the current EVAL_PROMPT_VERSION
// are skipped unless --force is given. Requires OPENAI_API_KEY (or AWS secret)
// and a reachable database.
import { pool } from '../../server/config/db.js';
import {
  evaluateSessionDetailed,
  evaluateAllEnded,
  EVAL_PROMPT_VERSION,
  EVAL_DIMENSIONS,
  type RunEvalOptions,
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
  const judgeModelsArg = getArg('--judge-models');
  const selfConsistencyArg = getArg('--self-consistency');
  const options: RunEvalOptions = {
    force,
    judgeModel,
    judgeModels: judgeModelsArg ? judgeModelsArg.split(',').map(m => m.trim()).filter(Boolean) : undefined,
    selfConsistencyRuns: selfConsistencyArg ? Number(selfConsistencyArg) : undefined,
  };

  if (!sessionId && !allEnded) {
    console.log('Usage: npx tsx src/database/scripts/runEvals.ts (--session <id> | --all-ended) [--force] ' +
      '[--judge-model <model> | --judge-models <m1,m2>] [--self-consistency <k>]');
    process.exitCode = 1;
    return;
  }

  console.log(`[Evals] prompt version ${EVAL_PROMPT_VERSION}${force ? ' (force re-run)' : ''}`);

  if (sessionId) {
    const detailed = await evaluateSessionDetailed(sessionId, options);
    if (!detailed) {
      console.log(`[Evals] ${sessionId}: skipped (not found / not ended / empty transcript / already evaluated)`);
    } else {
      const { row, runs, failed, spread } = detailed;
      console.log(`[Evals] ${sessionId}: stored eval #${row.eval_id} (judge ${row.judge_model})`);
      for (const [dim, entry] of Object.entries(row.rubric)) {
        console.log(`  ${dim}: ${entry.score}/5 — ${entry.rationale}`);
      }
      if (row.overall_comments) console.log(`  overall: ${row.overall_comments}`);
      if (runs.length > 1) {
        console.log(`[Evals] per-judge scores (${runs.length} runs):`);
        for (const run of runs) {
          const label = run.runIndex > 0 ? `${run.judgeModel}#${run.runIndex + 1} (seed ${run.seed})` : run.judgeModel;
          console.log(`  ${label}: ${EVAL_DIMENSIONS.map(d => `${d}=${run.rubric[d].score}`).join(' ')}`);
        }
        if (spread) console.log(`  spread (max-min): ${EVAL_DIMENSIONS.map(d => `${d}=${spread[d]}`).join(' ')}`);
      }
      for (const f of failed) console.log(`[Evals] judge ${f.judgeModel} run ${f.runIndex + 1} FAILED: ${f.error}`);
    }
  } else {
    const result = await evaluateAllEnded(options);
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
