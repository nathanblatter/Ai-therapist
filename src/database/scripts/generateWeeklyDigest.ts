// Weekly PI digest generator (eval spec WP7 - see docs/eval-system.md,
// "Weekly digest").
//
// Usage:
//   npx tsx src/database/scripts/generateWeeklyDigest.ts                       # last complete week, irb-study org, archive it
//   npx tsx src/database/scripts/generateWeeklyDigest.ts --week-ending 2026-10-18
//   npx tsx src/database/scripts/generateWeeklyDigest.ts --org irb-study       # slug or numeric org id
//   npx tsx src/database/scripts/generateWeeklyDigest.ts --print               # write the markdown to stdout, do not archive
//
// Without --print the digest is stored in weekly_digests (generated_by = the
// invoking OS user, prefixed "cli:") and its id is printed. Nothing is emailed.
import { pool } from '../../server/config/db.js';
import { getOrganizationBySlug, getOrganizationById, getIrbStudyOrgId } from '../../server/db/organizations.queries.js';
import {
  buildWeeklyDigest,
  generateAndStoreWeeklyDigest,
  defaultWeekEnding,
  isValidWeekEnding,
} from '../../server/services/weeklyDigest.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function resolveOrg(raw: string | undefined): Promise<number | null> {
  if (!raw) return getIrbStudyOrgId();
  if (/^\d+$/.test(raw)) return (await getOrganizationById(Number(raw)))?.org_id ?? null;
  return (await getOrganizationBySlug(raw))?.org_id ?? null;
}

async function main(): Promise<void> {
  const weekEnding = getArg('--week-ending') ?? defaultWeekEnding();
  const print = process.argv.includes('--print');
  if (!isValidWeekEnding(weekEnding)) {
    console.error(`--week-ending must be YYYY-MM-DD (got ${weekEnding})`);
    process.exitCode = 1;
    return;
  }
  const orgId = await resolveOrg(getArg('--org'));
  if (orgId === null) {
    console.error(`organization not found: ${getArg('--org') ?? 'irb-study'}`);
    process.exitCode = 1;
    return;
  }

  if (print) {
    const digest = await buildWeeklyDigest({ weekEnding, orgId });
    process.stdout.write(digest.markdown);
    return;
  }
  const user = process.env.USER || process.env.USERNAME || 'unknown';
  const row = await generateAndStoreWeeklyDigest({ weekEnding, orgId, generatedBy: `cli:${user}` });
  console.log(`[WeeklyDigest] stored digest #${row.id} for org ${orgId}, week ending ${row.week_ending} (${row.markdown.length} chars)`);
}

main()
  .catch(err => {
    console.error('[WeeklyDigest] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
