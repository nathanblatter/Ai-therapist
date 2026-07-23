// Ingest the psychoeducation seed corpus into knowledge_chunks: embed each
// passage with text-embedding-3-small and upsert (idempotent by content_hash).
// Run AFTER migration 031, from the app container (DATABASE_URL + OPENAI key set):
//   npx tsx src/database/scripts/ingestKnowledge.js
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

async function ingest() {
  const seedPath = path.join(__dirname, '../seeds/psychoeducation.seed.json');
  const chunks = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  console.log(`Ingesting ${chunks.length} psychoeducation chunks from ${path.basename(seedPath)}...`);

  let ok = 0;
  for (const c of chunks) {
    if (!c.content || !c.source) {
      console.error(`  ✗ skipping malformed chunk (missing content/source): ${JSON.stringify(c).slice(0, 80)}`);
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
        content_hash: contentHash,
        embedding,
      });
      ok++;
      console.log(`  ✓ ${c.title ?? contentHash.slice(0, 8)}`);
    } catch (err) {
      console.error(`  ✗ ${c.title ?? '(untitled)'}: ${err.message}`);
    }
  }

  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE embedding IS NOT NULL');
  console.log(`Done: ${ok}/${chunks.length} embedded this run; ${rows[0].n} total chunks embedded in the knowledge base.`);
}

ingest()
  .then(() => pool.end())
  .catch((e) => {
    console.error('Ingest failed:', e);
    pool.end();
    process.exit(1);
  });
