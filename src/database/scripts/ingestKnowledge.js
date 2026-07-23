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

// Each seed file's default kind; individual chunks may override via a `kind` field.
const SEED_FILES = [
  { file: 'psychoeducation.seed.json', kind: 'psychoeducation' },
  { file: 'worksheets.seed.json', kind: 'worksheet' },
  { file: 'techniques.seed.json', kind: 'technique' },
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
        });
        ok++;
        console.log(`  ✓ [${c.kind ?? seed.kind}] ${c.title ?? contentHash.slice(0, 8)}`);
      } catch (err) {
        console.error(`  ✗ ${c.title ?? '(untitled)'}: ${err.message}`);
      }
    }
  }

  const { rows } = await pool.query(
    `SELECT kind, COUNT(*) AS n FROM knowledge_chunks WHERE embedding IS NOT NULL GROUP BY kind ORDER BY kind`
  );
  console.log(`Done: ${ok}/${total} embedded this run. Knowledge base by kind:`);
  rows.forEach(r => console.log(`  ${r.kind}: ${r.n}`));
}

ingest()
  .then(() => pool.end())
  .catch((e) => {
    console.error('Ingest failed:', e);
    pool.end();
    process.exit(1);
  });
