// Render the IRB red-team attachment from a red-team results file.
//
//   npm run irb:redteam -- --from <summary.json> [--run-url <url>]
//                          [--model "<function>=<model id>"]... [--prepared "<Month D, YYYY>"] [--out <path>]
//
// --from      summary.json written by the harness (e.g. from
//             `gh run download <id> --name redteam-full-results --dir <fresh dir>`)
// --run-url   where the file came from, shown as the attachment's Source
// --model     a model used in the run; repeatable. Use the code defaults at the
//             run's commit (the harness runs on a scratch database)
// --prepared  date shown on the attachment (default: today)
// --out       output path (default: docs/irb-phase2-instruments/redteam.html)
//
// Makes no network or API calls.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { ATTACHMENT_PATH, ATTACHMENT_URL, parseRunSummary, renderRedteamAttachment } from './redteamAttachment.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'run-url': { type: 'string' },
    model: { type: 'string', multiple: true },
    prepared: { type: 'string' },
    out: { type: 'string' },
  },
});

if (!values.from) {
  console.error('usage: npm run irb:redteam -- --from <summary.json> [--run-url <url>] [--model "<function>=<id>"]...');
  process.exit(2);
}

const bytes = readFileSync(values.from);
const run = parseRunSummary(JSON.parse(bytes.toString('utf8')));

const models: Array<[string, string]> = (values.model ?? []).map((m) => {
  const i = m.lastIndexOf('=');
  if (i <= 0 || i === m.length - 1) {
    console.error(`--model expects "<function>=<model id>", got: ${m}`);
    process.exit(2);
  }
  return [m.slice(0, i).trim(), m.slice(i + 1).trim()];
});

const prepared =
  values.prepared ??
  new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Denver',
  });

const html = renderRedteamAttachment(run, {
  prepared,
  sourceLabel: values['run-url'] ?? `results file ${values.from.split('/').pop()}`,
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  models,
});

const out = values.out ?? ATTACHMENT_URL;
writeFileSync(out, html);
console.log(`wrote ${values.out ?? ATTACHMENT_PATH} (${run.scenarios.length} scenarios, suite ${run.suite})`);
