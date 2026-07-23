// Ingest the RAG seed corpora into knowledge_chunks: embed each passage with
// text-embedding-3-small and upsert (idempotent by content_hash). Loads three
// kinds — psychoeducation prose, worksheets, and modality techniques.
// Run AFTER migrations 031 + 032, from the app container (DATABASE_URL + OPENAI
// key set):  npx tsx src/database/scripts/ingestKnowledge.js
// Re-running is safe: unchanged passages are updated in place, edited ones re-embedded.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../server/config/db.js';
import { embedText } from '../../server/services/embeddings.service.js';
import { upsertKnowledgeChunk } from '../../server/db/knowledge.queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Each seed file's default kind + approval state. The original baseline files
// are active; the *_expansion files ingest as pending (active:false) so nothing
// new goes live until it's approved. Individual chunks may override `kind` /
// `active`. Re-ingest never overwrites an already-approved chunk.
const SEED_FILES = [
  { file: 'psychoeducation.seed.json', kind: 'psychoeducation', defaultActive: true },
  { file: 'worksheets.seed.json', kind: 'worksheet', defaultActive: true },
  { file: 'techniques.seed.json', kind: 'technique', defaultActive: true },
  { file: 'psychoeducation_expansion.seed.json', kind: 'psychoeducation', defaultActive: false },
  { file: 'psychoeducation_expansion2.seed.json', kind: 'psychoeducation', defaultActive: false },
  { file: 'worksheets_expansion.seed.json', kind: 'worksheet', defaultActive: false },
  { file: 'techniques_expansion.seed.json', kind: 'technique', defaultActive: false },
];

async function ingest() {
  let total = 0;
  let ok = 0;

  for (const seed of SEED_FILES) {
    const seedPath = path.join(__dirname, '../seeds', seed.file);
    if (!fs.existsSync(seedPath)) {
      console.log(`  (skipping ${seed.file} — not found)`);
      continue;
    }
    const chunks = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    console.log(`Ingesting ${chunks.length} '${seed.kind}' chunks from ${seed.file}...`);

    for (const c of chunks) {
      total++;
      if (!c.content || !c.source) {
        console.error(`  ✗ skipping malformed chunk (missing content/source)`);
        continue;
      }
      try {
        const contentHash = crypto.createHash('md5').update(c.content).digest('hex');
        const embedding = await embedText(c.content);
        await upsertKnowledgeChunk({
          topic: c.topic ?? null,
          title: c.title ?? null,
          content: c.content,
          source: c.source,
          source_url: c.source_url ?? null,
          license: c.license ?? null,
          kind: c.kind ?? seed.kind,
          modality: c.modality ?? null,
          metadata: c.metadata ?? null,
          content_hash: contentHash,
          embedding,
          // Per-chunk override, else the file's default. Approval flips it later;
          // re-ingest never overwrites an approval (see upsertKnowledgeChunk).
          active: c.active ?? seed.defaultActive,
        });
        ok++;
        const isActive = c.active ?? seed.defaultActive;
        console.log(`  ${isActive ? '✓' : '⏳'} [${c.kind ?? seed.kind}] ${c.title ?? contentHash.slice(0, 8)}`);
      } catch (err) {
        console.error(`  ✗ ${c.title ?? '(untitled)'}: ${err.message}`);
      }
    }
  }

  const { rows } = await pool.query(
    `SELECT kind,
            COUNT(*) FILTER (WHERE active IS TRUE) AS active,
            COUNT(*) FILTER (WHERE active IS NOT TRUE) AS pending
     FROM knowledge_chunks WHERE embedding IS NOT NULL GROUP BY kind ORDER BY kind`
  );
  console.log(`Done: ${ok}/${total} embedded this run. Knowledge base by kind:`);
  rows.forEach(r => console.log(`  ${r.kind}: ${r.active} active, ${r.pending} pending approval`));
}

ingest()
  .then(() => pool.end())
  .catch((e) => {
    console.error('Ingest failed:', e);
    pool.end();
    process.exit(1);
  });
