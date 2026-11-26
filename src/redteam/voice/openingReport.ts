// Per-delivery numbers from one or more `voice-opening` runs (ai-therapist-315).
//
//   npx tsx src/redteam/voice/openingReport.ts <summary.json> [<summary.json> ...]
//
// Reads the `live-opening-measure` assertions the opening-only runner wrote
// (voice/openingOnly.ts) and prints a Markdown table: one column per
// LIVE_OPENING_DELIVERY the runs were made under. A start that errored before
// it could be measured (no session, a refused mint) is counted separately and
// never as a silent start. Appends to $GITHUB_STEP_SUMMARY when set. It never
// sets the exit code.
import fs from 'node:fs';
import { formatOpeningStats, measurementsFromSummary, openingStats, type OpeningMeasurement } from './openingOnly.js';

interface SummaryLike {
  scenarios?: Array<{ id: string; error?: string; assertions?: Array<{ id: string; detail: string }> }>;
}

export function formatOpeningReport(summaries: SummaryLike[]): string {
  const all: OpeningMeasurement[] = summaries.flatMap((s) => measurementsFromSummary(s));
  const errored = summaries.flatMap((s) => (s.scenarios ?? []).filter((sc) => sc.error));
  let md = '## GPT-Live opening-only starts\n\n';
  if (all.length === 0) md += 'No measured start in the given results.\n';
  else md += formatOpeningStats(openingStats(all));
  if (errored.length) {
    md += `\n${errored.length} start(s) errored before they could be measured (not counted above):\n`;
    for (const sc of errored) md += `- ${sc.id}: ${String(sc.error).replace(/\r?\n/g, ' ').slice(0, 240)}\n`;
  }
  return md;
}

const invokedDirectly = process.argv[1]?.endsWith('openingReport.ts') || process.argv[1]?.endsWith('openingReport.js');
if (invokedDirectly) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: openingReport.ts <summary.json> [<summary.json> ...]');
    process.exit(2);
  }
  const md = formatOpeningReport(paths.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')) as SummaryLike));
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) fs.appendFileSync(target, md);
  else process.stdout.write(md);
}
