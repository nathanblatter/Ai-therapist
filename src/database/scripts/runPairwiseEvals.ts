// Offline pairwise A/B eval runner (ai-therapist-81 — see docs/eval-system.md).
//
// Usage:
//   npx tsx src/database/scripts/runPairwiseEvals.ts --axis <ai_model|proactive_offering>
//            [--limit N] [--judge-model <model>]
//
// Matches ended sessions within identical (modality, duration band) strata
// across arms of the axis and judges each pair in both orderings (2 judge
// calls/pair). Idempotent: sessions already used in a stored pair for the
// current PAIRWISE_PROMPT_VERSION are skipped. Requires OPENAI_API_KEY and a
// reachable database.
import { pool } from '../../server/config/db.js';
import {
  runPairwiseBatch,
  PAIRWISE_PROMPT_VERSION,
} from '../../server/services/pairwiseEval.service.js';
import { getPairwiseAggregates } from '../../server/db/index.js';
import type { ComparisonAxis } from '../../server/db/index.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const axis = getArg('--axis') as ComparisonAxis | undefined;
  const limitArg = getArg('--limit');
  const judgeModel = getArg('--judge-model');

  if (axis !== 'ai_model' && axis !== 'proactive_offering') {
    console.log(
      'Usage: npx tsx src/database/scripts/runPairwiseEvals.ts --axis <ai_model|proactive_offering> [--limit N] [--judge-model <model>]'
    );
    process.exitCode = 1;
    return;
  }

  const limit = limitArg ? parseInt(limitArg, 10) : undefined;
  console.log(`[Pairwise] axis=${axis} prompt version ${PAIRWISE_PROMPT_VERSION}`);

  const result = await runPairwiseBatch(axis, { limit, judgeModel });
  console.log(
    `[Pairwise] done: ${result.paired} matched, ${result.judged} judged, ${result.skipped} skipped, ${result.failed} failed`
  );

  // Show current aggregate standings for this axis + prompt version.
  const aggregates = (await getPairwiseAggregates(PAIRWISE_PROMPT_VERSION)).filter(
    a => a.comparison_axis === axis
  );
  for (const a of aggregates) {
    console.log(
      `  ${a.arm_x} vs ${a.arm_y}: ${a.wins_x}-${a.wins_y} (ties ${a.ties}, incons ${a.inconsistent}, n=${a.total})`
    );
  }

  if (result.failed > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error('[Pairwise] fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
