// Risk-score calibration harness CLI (eval spec WP3 - see docs/eval-system.md,
// "Risk-score calibration").
//
// Usage:
//   npx tsx src/database/scripts/runRiskCalibration.ts                          # last 365 days, irb-study org, 50-message miss-rate sample, store the run
//   npx tsx src/database/scripts/runRiskCalibration.ts --since 2026-06-01       # window lower bound (ISO date or datetime); --until likewise
//   npx tsx src/database/scripts/runRiskCalibration.ts --sample-size 100        # miss-rate sample size (0 = skip the LLM re-score entirely)
//   npx tsx src/database/scripts/runRiskCalibration.ts --dry-run                # no LLM calls: print the sampled message ids and the label counts, store nothing
//   npx tsx src/database/scripts/runRiskCalibration.ts --print                  # write the report JSON to stdout, store nothing
//   npx tsx src/database/scripts/runRiskCalibration.ts --org irb-study          # slug or numeric org id
//   npx tsx src/database/scripts/runRiskCalibration.ts --seed 7                 # sampler seed (default 20261023)
//   npx tsx src/database/scripts/runRiskCalibration.ts --no-unflagged-negative  # do not treat un-flagged scored messages as negatives
//
// Spend: the miss-rate sample calls the live assessor (gpt-4o-mini) once per
// sampled message, from content_redacted only, under a hard cap of
// MISS_RATE_BUDGET_USD (0.50). --dry-run and --sample-size 0 make no calls.
// Recommendations in the stored run are ADVISORY: nothing here changes the
// live thresholds.
import { pool } from '../../server/config/db.js';
import { getOrganizationBySlug, getOrganizationById, getIrbStudyOrgId } from '../../server/db/organizations.queries.js';
import {
  buildRiskCalibrationReport,
  runAndStoreRiskCalibration,
  normalizeParams,
  MISS_RATE_BUDGET_USD,
} from '../../server/services/riskCalibration.service.js';

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
  const dryRun = process.argv.includes('--dry-run');
  const print = process.argv.includes('--print');
  const sampleSizeRaw = getArg('--sample-size');
  const seedRaw = getArg('--seed');
  const params = normalizeParams({
    since: getArg('--since'),
    until: getArg('--until'),
    sample_size: sampleSizeRaw === undefined ? undefined : Number(sampleSizeRaw),
    seed: seedRaw === undefined ? undefined : Number(seedRaw),
    dry_run: dryRun,
    unflagged_as_negative: !process.argv.includes('--no-unflagged-negative'),
  });
  const orgId = await resolveOrg(getArg('--org'));
  if (orgId === null) {
    console.error(`organization not found: ${getArg('--org') ?? 'irb-study'}`);
    process.exitCode = 1;
    return;
  }

  console.error(
    `[RiskCalibration] org ${orgId}, window ${params.since} .. ${params.until}, sample ${params.sample_size}, ` +
      `seed ${params.seed}, unflagged_as_negative=${params.unflagged_as_negative}, ` +
      `${dryRun ? 'DRY RUN (no LLM calls, nothing stored)' : `live re-score capped at $${MISS_RATE_BUDGET_USD}`}`,
  );

  if (dryRun || print) {
    const report = await buildRiskCalibrationReport({ orgId, params });
    if (print) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const l = report.labels;
      console.log(
        `[RiskCalibration] labels: ${l.scored_messages} scored messages, ${l.with_event} with a crisis event, ` +
          `${l.positives} positive, ${l.negatives} negative (${l.negatives_assumed_unflagged} assumed from no event), ` +
          `${l.excluded_unadjudicated} unadjudicated, ${l.excluded_unclear + l.excluded_disputed} unclear/disputed` +
          ` -> ${l.insufficient_labels ? 'INSUFFICIENT LABELS (need >= ' + l.min_labels_per_class + ' per class)' : 'metrics computed'}`,
      );
      console.log(
        `[RiskCalibration] adjudication coverage: ${l.coverage.adjudicated_events}/${l.coverage.flagged_events} flagged events adjudicated ` +
          `(${l.coverage.confirmed} confirmed, ${l.coverage.false_positive} false_positive, ${l.coverage.unclear} unclear)`,
      );
      const m = report.miss_rate;
      if (m) {
        console.log(
          `[RiskCalibration] miss-rate sample: ${m.sampled} of ${m.candidates} unflagged candidates would be re-scored`,
        );
        for (const s of m.by_stratum) console.log(`  ${s.stratum}: ${s.sampled} of ${s.candidates}`);
        console.log(`  message ids: ${m.sampled_message_ids.join(', ') || '(none)'}`);
      }
    }
    return;
  }

  const user = process.env.USER || process.env.USERNAME || 'unknown';
  const row = await runAndStoreRiskCalibration({ orgId, params, createdBy: `cli:${user}` });
  const report = row.report as {
    labels: { insufficient_labels: boolean; positives: number; negatives: number };
    miss_rate: {
      scored: number;
      sampled: number;
      spend_usd: number;
      fraction_ge_50: number | null;
      fraction_ge_75: number | null;
    } | null;
  };
  console.log(
    `[RiskCalibration] stored run #${row.run_id} for org ${orgId}: ` +
      `${report.labels.positives}+/${report.labels.negatives}- ` +
      `(${report.labels.insufficient_labels ? 'insufficient labels' : 'metrics computed'}); ` +
      (report.miss_rate
        ? `miss-rate ${report.miss_rate.scored}/${report.miss_rate.sampled} scored, >=50: ${report.miss_rate.fraction_ge_50 ?? 'n/a'}, >=75: ${report.miss_rate.fraction_ge_75 ?? 'n/a'}, spend $${report.miss_rate.spend_usd}`
        : 'no miss-rate sample'),
  );
}

main()
  .catch((err) => {
    console.error('[RiskCalibration] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
