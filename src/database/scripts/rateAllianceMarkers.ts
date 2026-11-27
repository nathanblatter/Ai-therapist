// Linguistic working-alliance markers (ai-therapist-173): list, and
// optionally rate, the eligible sessions that have no rating under the
// current judge version.
//
// Usage:
//   npx tsx src/database/scripts/rateAllianceMarkers.ts [--limit <n>]
//   npx tsx src/database/scripts/rateAllianceMarkers.ts --rate [--limit <n>]
//   npx tsx src/database/scripts/rateAllianceMarkers.ts --rate --session <id> [--force]
//
// Default is LIST ONLY: no OpenAI call and no write. It prints how many
// eligible sessions are waiting (ended, not demo / harness / sandbox,
// redaction complete, no answer for the current judge version; a session
// whose earlier attempt errored counts as waiting). It never prints message
// text.
//
// --rate calls the judge: one OpenAI Decisions API call per session (input
// tokens only; none for a session under the length floor) and one row written
// to session_alliance_ratings per session. Only messages.content_redacted is
// read. Running this script is the opt-in: it does not consult
// system_config.alliance_markers, which gates only the automatic post-session
// job. --force re-rates a session that already has an answer (with --session).
//
// Reads DATABASE_URL and OPENAI_API_KEY like the app. Not run by CI. Do not
// leave a long run going across the mini's Friday-night restart.
import { pool } from '../../server/config/db.js';
import { getSessionsNeedingAllianceRating } from '../../server/db/index.js';
import { ALLIANCE_JUDGE_VERSION } from '../../server/services/allianceMarkers.js';
import { backfillAllianceRatings, rateSessionAlliance } from '../../server/services/allianceRating.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const rate = process.argv.includes('--rate');
  const force = process.argv.includes('--force');
  const sessionId = getArg('--session');
  const limitArg = getArg('--limit');
  const limit = limitArg === undefined ? null : Number(limitArg);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`[AllianceBackfill] --limit must be a positive integer, got ${limitArg}`);
    process.exitCode = 1;
    return;
  }
  if (force && !sessionId) {
    console.error('[AllianceBackfill] --force needs --session <id>: re-rating everything is not supported');
    process.exitCode = 1;
    return;
  }

  if (sessionId) {
    if (!rate) {
      console.log('[AllianceBackfill] list only: nothing was sent or written. Add --rate to rate this session.');
      return;
    }
    const result = await rateSessionAlliance(sessionId, { force });
    if (result.outcome === 'skipped') {
      console.log(`[AllianceBackfill] ${sessionId}: skipped (${result.reason})`);
    } else {
      const r = result.row;
      console.log(
        `[AllianceBackfill] ${sessionId}: ${r.status}` +
          (r.status === 'rated'
            ? ` task=${r.task_rateable ? r.task_level : 'n/r'} bond=${r.bond_rateable ? r.bond_level : 'n/r'} goal=${r.goal_rateable ? r.goal_level : 'n/r'}`
            : r.status === 'errored'
              ? ` (${r.error})`
              : ''),
      );
    }
    return;
  }

  const waiting = await getSessionsNeedingAllianceRating(ALLIANCE_JUDGE_VERSION, { limit });
  console.log(
    `[AllianceBackfill] ${waiting.length} eligible session(s) with no ${ALLIANCE_JUDGE_VERSION} rating` +
      (limit !== null ? ` (limited to ${limit})` : ''),
  );
  if (!rate) {
    console.log('[AllianceBackfill] list only: nothing was sent or written. Re-run with --rate to rate them.');
    return;
  }
  if (waiting.length === 0) return;
  console.log(`[AllianceBackfill] --rate: up to ${waiting.length} OpenAI call(s) now...`);
  const s = await backfillAllianceRatings({ limit });
  console.log(
    `[AllianceBackfill] done: ${s.rated} rated, ${s.tooShort} too short to rate (no model call), ` +
      `${s.errored} errored (will be listed again), ${s.skipped} skipped`,
  );
}

main()
  .catch((err) => {
    console.error('[AllianceBackfill] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
