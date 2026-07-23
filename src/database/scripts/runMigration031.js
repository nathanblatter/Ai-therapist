import { pool } from '../../server/config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Running migration 031: Create psychoeducation knowledge base (pgvector)...');

    const sql = fs.readFileSync(
      path.join(__dirname, '../migrations/031_knowledge_base.sql'),
      'utf8'
    );

    await client.query(sql);

    console.log('Migration 031 completed. Next: `npx tsx src/database/scripts/ingestKnowledge.js` to load the corpus.');
  } catch (err) {
    console.error('Migration 031 failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
