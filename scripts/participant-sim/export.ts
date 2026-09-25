// Participant simulation — phase 4: run the REAL de-identified dataset export
// (datasetExport.service.buildDataset) as of the sim "today" and write every
// file to an output dir, exactly as a researcher would receive it from
// GET /admin/api/export/dataset?includeTranscripts=true.
//
//   DATABASE_URL=... npx tsx scripts/participant-sim/export.ts <asOf-iso> <outDir>
import 'dotenv/config';
process.env.NODE_ENV = 'test';

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function main() {
  const asOf = process.argv[2] ?? '2026-09-07T23:59:59Z';
  const outDir = process.argv[3] ?? 'scripts/participant-sim/export-out';

  const { buildDataset } = await import('../../src/server/services/datasetExport.service.js');
  const result = await buildDataset(asOf, { includeTranscripts: true, generatedAt: asOf });

  await mkdir(outDir, { recursive: true });
  const tDir = join(outDir, 'transcripts');
  await mkdir(tDir, { recursive: true });

  for (const f of result.main) await writeFile(join(outDir, f.name), f.content);
  if (result.transcripts) for (const f of result.transcripts) await writeFile(join(tDir, f.name), f.content);

  console.log(`Export as of ${result.asOf} (git ${result.gitSha})`);
  console.log('Row counts:');
  for (const [k, v] of Object.entries(result.rowCounts)) console.log(`  ${k}: ${v}`);
  console.log(`\nMain files -> ${outDir}`);
  for (const f of result.main) console.log(`  ${f.name} (${f.content.split('\n').length - 1} lines)`);
  if (result.transcripts) {
    console.log(`Transcript files -> ${tDir}`);
    for (const f of result.transcripts) console.log(`  ${f.name} (${f.content.split('\n').length - 1} lines)`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
