// Rating-queue sampler CLI (eval program WP2 - see docs/eval-system.md,
// "Human rating queue").
//
// Usage:
//   npx tsx src/database/scripts/enqueueRatingSample.ts --size 40 [--since 2026-09-01] [--seed 7] [--dry-run]
//
// Stratifies ended, non-demo, non-sandbox sessions ended since --since
// (default: last 90 days) by modality x risk band x ISO week, oversamples
// crisis-adjacent sessions, marks evals.rating_second_rater_fraction of the
// picks for a second rater, and inserts them into eval_rating_queue with
// source 'stratified'. --dry-run prints the allocation without writing.
import { pool } from '../../server/config/db.js';
import { enqueueStratifiedSample } from '../../server/services/ratingSampler.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const size = Number(getArg('--size'));
  const sinceArg = getArg('--since');
  const seedArg = getArg('--seed');
  const dryRun = process.argv.includes('--dry-run');

  if (!Number.isInteger(size) || size < 1) {
    console.log('Usage: npx tsx src/database/scripts/enqueueRatingSample.ts --size <n> [--since <ISO date>] [--seed <int>] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const since = sinceArg ? new Date(sinceArg) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error(`[RatingQueue] --since is not a date: ${sinceArg}`);
    process.exitCode = 1;
    return;
  }
  const seed = seedArg ? Number(seedArg) : undefined;

  const result = await enqueueStratifiedSample({ size, since, seed, dryRun, enqueuedBy: null });
  console.log(
    `[RatingQueue] ${result.dry_run ? 'DRY RUN - ' : ''}since ${result.since} · seed ${result.seed} · ` +
      `${result.candidate_count} candidates · ${result.picks.length} picked · ` +
      `second-rater fraction ${result.second_rater_fraction}`
  );
  console.log('[RatingQueue] allocation (stratum: allocated / candidates, crisis-adjacent):');
  for (const a of result.allocations) {
    console.log(`  ${a.stratum}: ${a.allocated} / ${a.candidates} (${a.crisis_adjacent} crisis-adjacent)`);
  }
  const second = result.picks.filter(p => p.needs_second_rater).length;
  const crisis = result.picks.filter(p => p.crisis_adjacent).length;
  console.log(`[RatingQueue] picks: ${result.picks.length} (${crisis} crisis-adjacent, ${second} need a second rater)`);
  if (!result.dry_run) {
    console.log(`[RatingQueue] inserted ${result.inserted.length} queue row(s)` +
      (result.inserted.length < result.picks.length ? ' (the rest were already queued)' : ''));
  }
}

main()
  .catch(err => {
    console.error('[RatingQueue] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
