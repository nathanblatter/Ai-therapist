// De-identified research dataset export CLI (ai-therapist-96).
//
// Usage:
//   npm run export:dataset -- --out <dir> [--as-of 2026-08-31T23:59:59Z] [--include-transcripts]
//
// --out    Output directory. Default: ~/docker-services/ai-therapist-exports/dataset-<UTC date>/.
//          Paths under ~/Desktop or ~/Documents are REFUSED (iCloud/backup-hygiene risk):
//          exports must live under ~/docker-services/.
// --as-of  Inclusion cutoff (rows with created_at <= as_of). Same --as-of on two
//          runs yields byte-identical CSVs. Default: now (recorded in the codebook).
// --include-transcripts  Also writes the opt-in transcript artifact
//          (transcripts-<asOf>.zip: redacted turn text + verbatim feedback comments).
//
// Writes the CSVs + codebook.md loose into <out>, plus dataset-<stamp>.zip, and
// (when requested) transcripts-<stamp>.zip.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pool } from '../../server/config/db.js';
import {
  buildDataset,
  streamDatasetZip,
  type BuiltFile,
  type BuildResult,
} from '../../server/services/datasetExport.service.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/**
 * Refuse output paths under ~/Desktop or ~/Documents (macOS may sync these to
 * iCloud, and sensitive exports must not leave ~/docker-services/). Exported for
 * unit testing.
 */
export function assertSafeOutputPath(target: string): void {
  const resolved = path.resolve(target);
  const home = os.homedir();
  const forbidden = [path.join(home, 'Desktop'), path.join(home, 'Documents')];
  for (const dir of forbidden) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) {
      throw new Error(
        `Refusing to write export to ${resolved}: paths under ~/Desktop or ~/Documents are not allowed ` +
        `(iCloud/backup-hygiene risk). Use a path under ~/docker-services/.`
      );
    }
  }
}

async function zipToFile(result: BuildResult, main: boolean, filePath: string): Promise<void> {
  const out = fs.createWriteStream(filePath);
  // streamDatasetZip always writes main at root + nested transcripts; for a
  // transcripts-only zip we build a minimal result carrying just those files.
  const toStream: BuildResult = main
    ? { ...result, transcripts: null }
    : { ...result, main: result.transcripts as BuiltFile[], transcripts: null };
  await streamDatasetZip(toStream, out);
}

async function main() {
  const includeTranscripts = process.argv.includes('--include-transcripts');
  const asOf = getArg('--as-of') ?? new Date().toISOString();
  if (isNaN(new Date(asOf).getTime())) {
    console.error(`Invalid --as-of: ${asOf} (expected ISO-8601)`);
    process.exitCode = 1;
    return;
  }
  const stamp = asOf.slice(0, 10);
  const defaultOut = path.join(os.homedir(), 'docker-services', 'ai-therapist-exports', `dataset-${stamp}`);
  const outDir = getArg('--out') ?? defaultOut;

  try {
    assertSafeOutputPath(outDir);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[export] as_of=${asOf}`);
  console.log(`[export] writing to ${outDir}`);

  const result = await buildDataset(asOf, { includeTranscripts });

  // Loose CSVs + codebook.
  for (const f of result.main) {
    fs.writeFileSync(path.join(outDir, f.name), f.content);
  }
  const mainZip = path.join(outDir, `dataset-${stamp}.zip`);
  await zipToFile(result, true, mainZip);
  console.log(`[export] main bundle: ${result.main.length} files -> ${mainZip}`);
  for (const [file, count] of Object.entries(result.rowCounts)) {
    console.log(`         ${file}: ${count} rows`);
  }

  if (result.transcripts) {
    const tDir = path.join(outDir, `transcripts-${stamp}`);
    fs.mkdirSync(tDir, { recursive: true });
    for (const f of result.transcripts) {
      fs.writeFileSync(path.join(tDir, f.name), f.content);
    }
    const tZip = path.join(outDir, `transcripts-${stamp}.zip`);
    await zipToFile(result, false, tZip);
    console.log(`[export] opt-in transcript artifact -> ${tZip}`);
  }

  console.log(`[export] done.`);
}

// Only run as a CLI when executed directly (so tests can import the guard).
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main()
    .catch(err => {
      console.error('[export] fatal:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
