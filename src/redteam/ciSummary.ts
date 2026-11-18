// CI helper for red-team runs, run after the harness and the artifact upload:
//
//   tsx src/redteam/ciSummary.ts --dir redteam-results [--title "Red-team nightly"]
//       Render summary.json (+ diff.json) as markdown and append it to
//       $GITHUB_STEP_SUMMARY (stdout when that is unset).
//   tsx src/redteam/ciSummary.ts --dir redteam-results --check
//       Exit 1 when the run has failed assertions or errored scenarios, or when
//       summary.json is missing. Prints the verdict; writes no job summary.
//
// Kept separate from cli.ts so the nightly can run the suite with
// --allow-fail, upload results and write the summary first, and only then end
// the job red; the artifact therefore exists for every failed night and stays
// usable as the next night's baseline.
import fs from 'node:fs';
import path from 'node:path';
import { formatJobSummary, verdict, type SummaryFile } from './jobSummary.js';
import type { RunDiff } from './diff.js';

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  let dir = 'redteam-results';
  let title = 'Red-team';
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '--title') title = argv[++i];
    else if (argv[i] === '--check') check = true;
  }

  const summary = readJson<SummaryFile>(path.join(dir, 'summary.json'));

  if (check) {
    if (!summary) {
      console.error(`[redteam] ${path.join(dir, 'summary.json')} missing or unreadable: failing the run`);
      return 1;
    }
    const v = verdict(summary);
    const label = `${summary.suite ?? 'unknown'} suite, variant ${summary.variant?.name ?? 'default'}`;
    if (v.red) {
      console.error(
        `[redteam] ${label}: ${v.failedScenarios}/${v.scenarios} scenarios failed ` +
          `(${v.failedAssertions} failed assertions, ${v.erroredScenarios} errored); failing the run. ` +
          'Results were uploaded and are in the job summary.',
      );
      return 1;
    }
    console.log(`[redteam] ${label}: all ${v.scenarios} scenarios passed`);
    return 0;
  }

  const diff = readJson<RunDiff>(path.join(dir, 'diff.json'));
  const md = formatJobSummary({
    summary,
    diff,
    noDiffReason:
      'No baseline diff: no earlier result for this suite and variant was found, or the baseline was a different variant (see the step log).',
    title,
  });
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, md + '\n');
  else process.stdout.write(md);
  return 0;
}

process.exit(main(process.argv.slice(2)));
